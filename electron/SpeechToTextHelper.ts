// SpeechToTextHelper.ts
import { BrowserWindow, ipcMain } from 'electron'
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import { configHelper } from './ConfigHelper'
import { EventEmitter } from 'events'

interface SpeechToTextConfig {
  deepgramApiKey: string;
  isEnabled: boolean;
}

// Define a type for transcript data that includes speaker information
interface TranscriptData {
  text: string;
  speaker?: number | null;
  isFinal: boolean;
}

export class SpeechToTextHelper extends EventEmitter {
  private deepgramClient: ReturnType<typeof createClient> | null = null;
  private isListening: boolean = false;
  private liveTcp: any = null;
  private mainWindow: BrowserWindow | null = null;
  
  constructor(mainWindow: BrowserWindow) {
    super();
    this.mainWindow = mainWindow;
    this.initializeClient();
    
    // Listen for config updates
    configHelper.on('config-updated', this.handleConfigUpdate.bind(this));
    
    // Set up IPC handlers
    this.setupIpcHandlers();
  }
  
  /**
   * Initialize Deepgram client with API key from config
   */
  private initializeClient(): void {
    try {
      const config = this.loadSpeechConfig();
      
      if (config.deepgramApiKey && config.isEnabled) {
        // Create client with correct API key format
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
  
  /**
   * Load speech-to-text configuration
   */
  private loadSpeechConfig(): SpeechToTextConfig {
    const config = configHelper.loadConfig();
    const extendedConfig = configHelper.loadExtendedConfig();
    
    return {
      deepgramApiKey: extendedConfig?.deepgramApiKey || '',
      isEnabled: extendedConfig?.speechToTextEnabled || false
    };
  }
  
  /**
   * Handle config updates and re-initialize if necessary
   */
  private handleConfigUpdate(): void {
    this.initializeClient();
  }
  
  /**
   * Set up IPC handlers for renderer process communication
   */
  private setupIpcHandlers(): void {
    // Start listening for speech
    ipcMain.handle('start-speech-recognition', async () => {
      return await this.startListening();
    });
    
    // Stop listening for speech
    ipcMain.handle('stop-speech-recognition', async () => {
      return await this.stopListening();
    });
    
    // Update Deepgram API key
    ipcMain.handle('update-deepgram-key', async (_, apiKey: string) => {
      return await this.updateDeepgramKey(apiKey);
    });
    
    // Toggle speech recognition on/off
    ipcMain.handle('toggle-speech-recognition', async (_, enabled: boolean) => {
      return await this.toggleSpeechRecognition(enabled);
    });
    
    // Test Deepgram API key
    ipcMain.handle('test-deepgram-key', async (_, apiKey: string) => {
      return await this.testDeepgramKey(apiKey);
    });
    
    // Handle audio data from the renderer
    ipcMain.on('audio-data', (_, audioData: Buffer) => {
      this.sendAudioData(audioData);
    });
    
    // Add this new handler for manual transcript processing
    ipcMain.handle('process-transcript', async (_, transcript: string) => {
      return await this.processTranscript(transcript);
    });
  }
  
  /**
   * Start listening for speech input
   */
  public async startListening(): Promise<boolean> {
    if (this.isListening || !this.deepgramClient) {
      return false;
    }
    
    try {
      // Create a connection to Deepgram using the latest SDK API
      this.liveTcp = this.deepgramClient.listen.live({
        model: 'nova-3',
        smart_format: true,
        language: 'multi',
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        interim_results: true,
        diarize: true,     // Enable speaker diarization for meetings
      });
      
      // Set up event handlers
      this.liveTcp.on(LiveTranscriptionEvents.Open, () => {
        console.log('Deepgram connection established');
        this.isListening = true;
        
        // Notify renderer process that we're listening
        if (this.mainWindow) {
          this.mainWindow.webContents.send('speech-recognition-started');
        }
      });
      
      this.liveTcp.on(LiveTranscriptionEvents.Transcript, (data: any) => {
        // Handle incoming transcript
        if (data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
          const transcriptResult = data.channel.alternatives[0];
          const isFinal = data.is_final;
          
          // Check if there are any words with diarization information
          const hasDiarization = transcriptResult.words && 
                                transcriptResult.words.length > 0 && 
                                transcriptResult.words.some((w: any) => w.speaker !== undefined);
          
          if (transcriptResult.transcript && transcriptResult.transcript.trim() !== '') {
            console.log('Transcription received:', transcriptResult.transcript);
            
            // If we have diarization information, process it
            if (hasDiarization && transcriptResult.words && transcriptResult.words.length > 0) {
              // Group words by speaker
              const speakerSegments: Array<{speaker: number|null, text: string}> = [];
              let currentSpeaker: number|null = null;
              let currentText = '';
              
              for (const word of transcriptResult.words) {
                const speaker = word.speaker !== undefined ? word.speaker : null;
                
                // If speaker changes, start a new segment
                if (speaker !== currentSpeaker && currentText.trim() !== '') {
                  speakerSegments.push({
                    speaker: currentSpeaker,
                    text: currentText.trim()
                  });
                  currentText = '';
                }
                
                currentSpeaker = speaker;
                currentText += ' ' + word.word;
              }
              
              // Add the final segment
              if (currentText.trim() !== '') {
                speakerSegments.push({
                  speaker: currentSpeaker,
                  text: currentText.trim()
                });
              }
              
              // Format transcript with speaker information
              let formattedTranscript = '';
              speakerSegments.forEach(segment => {
                // Use "Interviewer" for speaker 0 and "You" for speaker 1
                const speakerName = segment.speaker === 0 ? 'Interviewer' : 'You';
                formattedTranscript += `${speakerName}: ${segment.text}\n`;
              });
              
              // Send formatted transcript to renderer process
              if (this.mainWindow) {
                this.mainWindow.webContents.send('speech-transcription', formattedTranscript.trim());
              }
              
              // Only process interviewer's questions when final
              if (isFinal) {
                // Find interviewer segments (speaker 0)
                const interviewerSegments = speakerSegments.filter(s => s.speaker === 0);
                
                if (interviewerSegments.length > 0) {
                  const interviewerText = interviewerSegments.map(s => s.text).join(' ');
                  // Emit event for other handlers, specifically for AI processing
                  this.emit('transcription', interviewerText);
                }
              }
            } else {
              // No diarization information, fall back to simple transcript
              // Send transcript to renderer process
              if (this.mainWindow) {
                this.mainWindow.webContents.send('speech-transcription', transcriptResult.transcript);
              }
              
              // Emit event for other handlers
              if (isFinal) {
                this.emit('transcription', transcriptResult.transcript);
              }
            }
          }
        }
      });
      
      this.liveTcp.on(LiveTranscriptionEvents.Error, (error: any) => {
        console.error('Deepgram error:', error);
        this.isListening = false;
        
        // Notify renderer of error
        if (this.mainWindow) {
          this.mainWindow.webContents.send('speech-recognition-error', error.message || 'Unknown error');
        }
      });
      
      this.liveTcp.on(LiveTranscriptionEvents.Close, () => {
        console.log('Deepgram connection closed');
        this.isListening = false;
        
        // Notify renderer process
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
  
  /**
   * Stop listening for speech input
   */
  public async stopListening(): Promise<boolean> {
    if (!this.isListening || !this.liveTcp) {
      return false;
    }
    
    try {
      this.liveTcp.finish();
      this.isListening = false;
      return true;
    } catch (error) {
      console.error('Failed to stop speech recognition:', error);
      return false;
    }
  }
  
  /**
   * Update the Deepgram API key
   */
  public async updateDeepgramKey(apiKey: string): Promise<boolean> {
    try {
      // Stop any active listening session
      if (this.isListening) {
        await this.stopListening();
      }
      
      // Update config
      const extendedConfig = configHelper.loadExtendedConfig() || {};
      configHelper.saveExtendedConfig({ 
        ...extendedConfig, 
        deepgramApiKey: apiKey 
      });
      
      // Re-initialize client
      this.initializeClient();
      
      return true;
    } catch (error) {
      console.error('Failed to update Deepgram API key:', error);
      return false;
    }
  }
  
  /**
   * Toggle speech recognition on/off
   */
  public async toggleSpeechRecognition(enabled: boolean): Promise<boolean> {
    try {
      // Update config
      const extendedConfig = configHelper.loadExtendedConfig() || {};
      configHelper.saveExtendedConfig({ 
        ...extendedConfig, 
        speechToTextEnabled: enabled 
      });
      
      // Stop listening if disabling
      if (!enabled && this.isListening) {
        await this.stopListening();
      }
      
      // Re-initialize client
      this.initializeClient();
      
      return true;
    } catch (error) {
      console.error('Failed to toggle speech recognition:', error);
      return false;
    }
  }
  
  /**
   * Test if a Deepgram API key is valid
   */
  public async testDeepgramKey(apiKey: string): Promise<{valid: boolean, error?: string}> {
    try {
      // Use a direct API call to test the key instead of using the SDK methods
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
          // Send minimal audio (empty string) just to test authentication
          buffer: ''
        })
      });
      
      // Only check if we get a non-401 response, which means the key is valid
      // We expect a 400 error for empty audio, but that means the key was accepted
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
  
  /**
   * Send audio data to Deepgram for transcription
   * @param audioData Binary audio data (16-bit PCM)
   */
  public sendAudioData(audioData: Buffer): void {
    if (this.isListening && this.liveTcp) {
      try {
        this.liveTcp.send(audioData);
      } catch (error) {
        console.error('Failed to send audio data to Deepgram:', error);
      }
    }
  }
  
  /**
   * Process a completed transcript with AI
   * @param transcript The completed transcript to process
   */
  public async processTranscript(transcript: string): Promise<boolean> {
    if (!transcript || transcript.trim() === '') {
      console.error('Empty transcript provided');
      return false;
    }

    try {
      // Emit the transcription event which will trigger AI processing
      this.emit('transcription', transcript);
      return true;
    } catch (error) {
      console.error('Error processing transcript:', error);
      return false;
    }
  }
}

// Create a global instance
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