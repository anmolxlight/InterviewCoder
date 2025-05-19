import { BrowserWindow, ipcMain } from 'electron'
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import { configHelper } from './ConfigHelper'
import { EventEmitter } from 'events'

interface SpeechToTextConfig {
  deepgramApiKey: string;
  isEnabled: boolean;
}

interface TranscriptData {
  text: string;
  speaker?: number | null;
  isFinal: boolean;
  transcriptId?: string; // Add unique identifier for transcripts
}

export class SpeechToTextHelper extends EventEmitter {
  private deepgramClient: ReturnType<typeof createClient> | null = null;
  private isListening: boolean = false;
  private liveTcp: any = null;
  private mainWindow: BrowserWindow | null = null;
  private lastProcessedText: string = '';
  private lastProcessedTime: number = 0;
  private readonly DEBOUNCE_TIME = 5000; // 5 seconds debounce time
  private processingDiarizedTranscript: boolean = false;
  private processedTranscriptIds: Set<string> = new Set(); // Track processed transcript IDs
  private lastEmittedTranscript: string = '';
  private lastEmittedTime: number = 0;
  private readonly EMIT_DEBOUNCE_TIME = 8000; // 8 seconds debounce time for emissions
  private firstSpeakerId: number | null = null; // Track the first speaker ID in a session
  
  constructor(mainWindow: BrowserWindow) {
    super();
    this.mainWindow = mainWindow;
    this.initializeClient();
    
    configHelper.on('config-updated', this.handleConfigUpdate.bind(this));
    this.setupIpcHandlers();
  }
  
  private initializeClient(): void {
    try {
      const config = this.loadSpeechConfig();
      
      if (config.deepgramApiKey && config.isEnabled) {
        this.deepgramClient = createClient(config.deepgramApiKey);
        console.log('Deepgram client initialized successfully');
      } else {
        this.deepgramClient = null;
        console.log('Speech-to-text disabled or missing API key');
      }
    } catch (error) {
      console.error('Failed to initialize Deepgram client:', error);
      this.deepgramClient = null;
    }
  }
  
  private loadSpeechConfig(): SpeechToTextConfig {
    const config = configHelper.loadConfig();
    const extendedConfig = configHelper.loadExtendedConfig();
    
    return {
      deepgramApiKey: extendedConfig?.deepgramApiKey || '',
      isEnabled: extendedConfig?.speechToTextEnabled || false
    };
  }
  
  private handleConfigUpdate(): void {
    this.initializeClient();
  }
  
  private setupIpcHandlers(): void {
    ipcMain.handle('start-speech-recognition', async () => {
      // Reset first speaker ID when starting a new session
      this.firstSpeakerId = null;
      return await this.startListening();
    });
    
    ipcMain.handle('stop-speech-recognition', async () => {
      return await this.stopListening();
    });
    
    ipcMain.handle('update-deepgram-key', async (_, apiKey: string) => {
      return await this.updateDeepgramKey(apiKey);
    });
    
    ipcMain.handle('toggle-speech-recognition', async (_, enabled: boolean) => {
      return await this.toggleSpeechRecognition(enabled);
    });
    
    ipcMain.handle('test-deepgram-key', async (_, apiKey: string) => {
      return await this.testDeepgramKey(apiKey);
    });
    
    ipcMain.on('audio-data', (_, audioData: Buffer) => {
      this.sendAudioData(audioData);
    });
    
    ipcMain.handle('process-transcript', async (_, transcript: string) => {
      return await this.processTranscript(transcript);
    });
  }
  
  public async startListening(): Promise<boolean> {
    if (this.isListening || !this.deepgramClient) {
      return false;
    }
    
    try {
      this.liveTcp = this.deepgramClient.listen.live({
        model: 'nova-3',
        smart_format: true,
        language: 'multi',
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        interim_results: true,
        diarize: true,
      });
      
      this.liveTcp.on(LiveTranscriptionEvents.Open, () => {
        console.log('Deepgram connection established');
        this.isListening = true;
        if (this.mainWindow) {
          this.mainWindow.webContents.send('speech-recognition-started');
        }
      });
      
      this.liveTcp.on(LiveTranscriptionEvents.Transcript, (data: any) => {
        if (data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
          const transcriptResult = data.channel.alternatives[0];
          const isFinal = data.is_final;
          
          const hasDiarization = transcriptResult.words && 
                               transcriptResult.words.length > 0 && 
                               transcriptResult.words.some((w: any) => w.speaker !== undefined);
          
          if (transcriptResult.transcript && transcriptResult.transcript.trim() !== '') {
            console.log('Transcription received:', transcriptResult.transcript);
            
            // Generate a unique ID for this transcript (based on text and timestamp)
            const transcriptId = `${transcriptResult.transcript}:${Date.now()}`;
            
            if (hasDiarization && transcriptResult.words && transcriptResult.words.length > 0) {
              this.processingDiarizedTranscript = true;
              
              // Identify the first speaker if not already set
              if (this.firstSpeakerId === null) {
                for (const word of transcriptResult.words) {
                  if (word.speaker !== undefined) {
                    this.firstSpeakerId = word.speaker;
                    console.log(`First speaker identified with ID: ${this.firstSpeakerId}`);
                    break;
                  }
                }
              }
              
              const speakerSegments: Array<{speaker: number|null, text: string}> = [];
              let currentSpeaker: number|null = null;
              let currentText = '';
              
              for (const word of transcriptResult.words) {
                // Map the actual speaker ID to our desired roles (first speaker = interviewer)
                const originalSpeaker = word.speaker !== undefined ? word.speaker : null;
                // If we have a first speaker ID, map speakers accordingly
                const mappedSpeaker = (this.firstSpeakerId !== null && originalSpeaker !== null) 
                  ? (originalSpeaker === this.firstSpeakerId ? 0 : 1) 
                  : originalSpeaker;
                
                if (mappedSpeaker !== currentSpeaker && currentText.trim() !== '') {
                  speakerSegments.push({
                    speaker: currentSpeaker,
                    text: currentText.trim()
                  });
                  currentText = '';
                }
                
                currentSpeaker = mappedSpeaker;
                currentText += ' ' + word.word;
              }
              
              if (currentText.trim() !== '') {
                speakerSegments.push({
                  speaker: currentSpeaker,
                  text: currentText.trim()
                });
              }
              
              let formattedTranscript = '';
              speakerSegments.forEach(segment => {
                const speakerName = segment.speaker === 0 ? 'Interviewer' : 'You';
                formattedTranscript += `${speakerName}: ${segment.text}\n`;
              });
              
              if (this.mainWindow) {
                this.mainWindow.webContents.send('speech-transcription', formattedTranscript.trim());
              }
              
              if (isFinal) {
                const interviewerSegments = speakerSegments.filter(s => s.speaker === 0);
                
                if (interviewerSegments.length > 0) {
                  const interviewerText = interviewerSegments.map(s => s.text).join(' ');
                  // Check if we've already emitted this transcript
                  const now = Date.now();
                  if (interviewerText !== this.lastEmittedTranscript || now - this.lastEmittedTime > this.EMIT_DEBOUNCE_TIME) {
                    // Emit event for other handlers, specifically for AI processing
                    this.emit('transcription', interviewerText);
                    this.lastEmittedTranscript = interviewerText;
                    this.lastEmittedTime = now;
                    console.log('Emitted transcription for AI processing (diarized):', interviewerText);
                  } else {
                    console.log('Skipped emitting duplicate transcription (diarized):', interviewerText);
                  }
                }
              }
              
              setTimeout(() => {
                this.processingDiarizedTranscript = false;
              }, 500);
            } else {
              if (this.mainWindow) {
                this.mainWindow.webContents.send('speech-transcription', transcriptResult.transcript);
              }
              
              if (isFinal && !this.processingDiarizedTranscript) {
                // Only emit if we're not currently processing a diarized version of this transcript
                const now = Date.now();
                if (transcriptResult.transcript !== this.lastEmittedTranscript || now - this.lastEmittedTime > this.EMIT_DEBOUNCE_TIME) {
                  this.emit('transcription', transcriptResult.transcript);
                  this.lastEmittedTranscript = transcriptResult.transcript;
                  this.lastEmittedTime = now;
                  console.log('Emitted transcription for AI processing (non-diarized):', transcriptResult.transcript);
                } else {
                  console.log('Skipped emitting duplicate transcription (non-diarized):', transcriptResult.transcript);
                }
              }
            }
          }
        }
      });
      
      this.liveTcp.on(LiveTranscriptionEvents.Error, (error: any) => {
        console.error('Deepgram error:', error);
        this.isListening = false;
        if (this.mainWindow) {
          this.mainWindow.webContents.send('speech-recognition-error', error.message || 'Unknown error');
        }
      });
      
      this.liveTcp.on(LiveTranscriptionEvents.Close, () => {
        console.log('Deepgram connection closed');
        this.isListening = false;
        if (this.mainWindow) {
          this.mainWindow.webContents.send('speech-recognition-stopped');
        }
      });
      
      return true;
    } catch (error) {
      console.error('Failed to start speech recognition:', error);
      this.isListening = false;
      return false;
    }
  }
  
  public async stopListening(): Promise<boolean> {
    if (!this.isListening || !this.liveTcp) {
      return false;
    }
    
    try {
      this.liveTcp.finish();
      this.isListening = false;
      this.processedTranscriptIds.clear(); // Clear processed IDs on stop
      // Reset first speaker ID when stopping
      this.firstSpeakerId = null;
      return true;
    } catch (error) {
      console.error('Failed to stop speech recognition:', error);
      return false;
    }
  }
  
  public async updateDeepgramKey(apiKey: string): Promise<boolean> {
    try {
      if (this.isListening) {
        await this.stopListening();
      }
      
      const extendedConfig = configHelper.loadExtendedConfig() || {};
      configHelper.saveExtendedConfig({ 
        ...extendedConfig, 
        deepgramApiKey: apiKey 
      });
      
      this.initializeClient();
      return true;
    } catch (error) {
      console.error('Failed to update Deepgram API key:', error);
      return false;
    }
  }
  
  public async toggleSpeechRecognition(enabled: boolean): Promise<boolean> {
    try {
      const extendedConfig = configHelper.loadExtendedConfig() || {};
      configHelper.saveExtendedConfig({ 
        ...extendedConfig, 
        speechToTextEnabled: enabled 
      });
      
      if (!enabled && this.isListening) {
        await this.stopListening();
      }
      
      this.initializeClient();
      return true;
    } catch (error) {
      console.error('Failed to toggle speech recognition:', error);
      return false;
    }
  }
  
  public async testDeepgramKey(apiKey: string): Promise<{valid: boolean, error?: string}> {
    try {
      const response = await fetch('https://api.deepgram.com/v1/listen', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          config: {
            model: 'nova-3',
            language: 'en'
          },
          buffer: ''
        })
      });
      
      if (response.status !== 401) {
        return { valid: true };
      }
      
      return { 
        valid: false, 
        error: 'Invalid Deepgram API key' 
      };
    } catch (error: any) {
      console.error('Deepgram API key test failed:', error);
      return { 
        valid: false, 
        error: error.message || 'Failed to validate Deepgram API key' 
      };
    }
  }
  
  public sendAudioData(audioData: Buffer): void {
    if (this.isListening && this.liveTcp) {
      try {
        this.liveTcp.send(audioData);
      } catch (error) {
        console.error('Failed to send audio data to Deepgram:', error);
      }
    }
  }
  
  public async processTranscript(transcript: string): Promise<boolean> {
    if (!transcript || transcript.trim() === '') {
      console.error('Empty transcript provided');
      return false;
    }

    try {
      const now = Date.now();
      const transcriptId = `${transcript}:${now}`;
      
      // Check for duplicate transcript
      if (
        transcript === this.lastProcessedText && 
        now - this.lastProcessedTime < this.DEBOUNCE_TIME
      ) {
        console.log('Skipping duplicate transcript processing');
        return true;
      }

      // Additional check for processed transcript ID
      if (this.processedTranscriptIds.has(transcriptId)) {
        console.log('Skipping already processed transcript ID');
        return true;
      }

      this.lastProcessedText = transcript;
      this.lastProcessedTime = now;
      this.processedTranscriptIds.add(transcriptId);

      this.emit('transcription', transcript);
      return true;
    } catch (error) {
      console.error('Error processing transcript:', error);
      return false;
    }
  }
}

let speechToTextHelper: SpeechToTextHelper | null = null;

export function initializeSpeechToTextHelper(mainWindow: BrowserWindow): SpeechToTextHelper {
  if (!speechToTextHelper) {
    speechToTextHelper = new SpeechToTextHelper(mainWindow);
  }
  return speechToTextHelper;
}

export function getSpeechToTextHelper(): SpeechToTextHelper | null {
  return speechToTextHelper;
}