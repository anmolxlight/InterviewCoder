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

interface QuestionBuffer {
  text: string;
  speaker: number | null;
  lastUpdateTime: number;
  wordCount: number;
  hasQuestionMarkers: boolean;
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
  
  // Enhanced VAD properties
  private questionBuffer: QuestionBuffer | null = null;
  private readonly QUESTION_COMPLETION_PAUSE = 2000; // 2 seconds pause to consider question complete
  private readonly MIN_QUESTION_LENGTH = 10; // Minimum characters for a valid question
  private readonly MAX_QUESTION_BUFFER_TIME = 30000; // 30 seconds max buffer time
  private questionCompletionTimer: NodeJS.Timeout | null = null;
  private lastSpeakerActivity: Map<number, number> = new Map(); // Track last activity per speaker
  private readonly SPEAKER_SWITCH_THRESHOLD = 1500; // 1.5 seconds to detect speaker switch
  private currentActiveSpeaker: number | null = null;
  private silenceStartTime: number | null = null;
  private readonly SILENCE_THRESHOLD = 1000; // 1 second of silence before considering pause
  
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
      // Reset all VAD state when starting a new session
      this.resetVADState();
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
  
  /**
   * Reset all Voice Activity Detection state
   */
  private resetVADState(): void {
    this.firstSpeakerId = null;
    this.questionBuffer = null;
    this.currentActiveSpeaker = null;
    this.silenceStartTime = null;
    this.lastSpeakerActivity.clear();
    
    if (this.questionCompletionTimer) {
      clearTimeout(this.questionCompletionTimer);
      this.questionCompletionTimer = null;
    }
    
    console.log('VAD state reset for new session');
  }

  /**
   * Enhanced question detection with context awareness
   */
  private isLikelyQuestion(text: string): boolean {
    if (!text || text.trim().length < 3) return false;
    
    const trimmedText = text.trim();
    
    // Direct question markers
    if (trimmedText.includes('?')) return true;
    
    // Question starters (more comprehensive)
    const questionStarters = [
      // Direct questions
      'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whose', 'whom',
      // Polite requests
      'can you', 'could you', 'will you', 'would you', 'please',
      // Explanations
      'tell me', 'explain', 'describe', 'elaborate', 'discuss', 'compare',
      // Collaborative
      'can we', 'should we', 'shall we',
      // Conditionals that are often questions
      'do you', 'did you', 'have you', 'are you', 'is there', 'are there',
      // Problem-solving
      'solve', 'implement', 'write', 'code', 'design', 'create'
    ];
    
    const lowerText = trimmedText.toLowerCase();
    
    // Check for question starters at beginning or after common prefixes
    const hasQuestionStarter = questionStarters.some(starter => {
      return lowerText.startsWith(starter + ' ') || 
             lowerText.startsWith(starter + ',') ||
             lowerText.includes(' ' + starter + ' ') ||
             lowerText.includes(', ' + starter + ' ');
    });
    
    // Check for imperative mood that sounds like instructions/questions
    const imperativePhrases = [
      'let me know', 'think about', 'consider', 'look at', 'show me',
      'walk me through', 'talk about', 'go through'
    ];
    
    const hasImperative = imperativePhrases.some(phrase => 
      lowerText.includes(phrase)
    );
    
    // Technical interview patterns
    const interviewPatterns = [
      'algorithm', 'complexity', 'optimize', 'efficient', 'solution',
      'approach', 'strategy', 'method', 'technique', 'implement',
      'time complexity', 'space complexity', 'big o', 'runtime'
    ];
    
    const hasInterviewPattern = interviewPatterns.some(pattern =>
      lowerText.includes(pattern)
    );
    
    return hasQuestionStarter || hasImperative || hasInterviewPattern;
  }

  /**
   * Check if text appears to be a complete question/statement
   */
  private isQuestionComplete(text: string): boolean {
    if (!text || text.trim().length < this.MIN_QUESTION_LENGTH) {
      return false;
    }
    
    const trimmedText = text.trim();
    
    // Has proper ending punctuation
    if (trimmedText.match(/[.!?]$/)) {
      return true;
    }
    
    // Long enough and has question characteristics
    if (trimmedText.length > 50 && this.isLikelyQuestion(trimmedText)) {
      // Check if it has a complete thought structure
      const hasSubjectVerb = /\b(you|i|we|they|he|she|it|this|that|there)\s+(are|is|can|could|should|would|will|do|did|have|has|want|need|think)/i.test(trimmedText);
      if (hasSubjectVerb) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Process question buffer and determine if ready to emit
   */
  private processQuestionBuffer(): void {
    if (!this.questionBuffer) return;
    
    const now = Date.now();
    const timeSinceLastUpdate = now - this.questionBuffer.lastUpdateTime;
    const totalBufferTime = now - (this.questionBuffer.lastUpdateTime - timeSinceLastUpdate);
    
    // Conditions to emit the question:
    // 1. Long pause after question-like content
    // 2. Question appears complete
    // 3. Buffer has been active too long (force emit)
    // 4. Speaker switched to candidate
    
    const shouldEmit = (
      timeSinceLastUpdate >= this.QUESTION_COMPLETION_PAUSE && 
      this.isLikelyQuestion(this.questionBuffer.text)
    ) || (
      this.isQuestionComplete(this.questionBuffer.text)
    ) || (
      totalBufferTime >= this.MAX_QUESTION_BUFFER_TIME
    ) || (
      this.currentActiveSpeaker !== null && 
      this.currentActiveSpeaker !== this.questionBuffer.speaker
    );
    
    if (shouldEmit) {
      this.emitCompleteQuestion(this.questionBuffer.text);
      this.questionBuffer = null;
      
      if (this.questionCompletionTimer) {
        clearTimeout(this.questionCompletionTimer);
        this.questionCompletionTimer = null;
      }
    }
  }

  /**
   * Emit a complete question for AI processing
   */
  private emitCompleteQuestion(questionText: string): void {
    if (!questionText || questionText.trim().length === 0) return;
    
    const trimmedQuestion = questionText.trim();
    
    // Final validation
    if (!this.isLikelyQuestion(trimmedQuestion)) {
      console.log('Skipping emission - text does not appear to be a question:', trimmedQuestion);
      return;
    }
    
    // Check against recent emissions to avoid duplicates
    const now = Date.now();
    if (trimmedQuestion === this.lastEmittedTranscript && 
        now - this.lastEmittedTime < this.EMIT_DEBOUNCE_TIME) {
      console.log('Skipping duplicate question emission:', trimmedQuestion);
      return;
    }
    
    console.log('Emitting complete question for AI processing:', trimmedQuestion);
    this.lastEmittedTranscript = trimmedQuestion;
    this.lastEmittedTime = now;
    
    // Emit the transcription event for AI processing
    this.emit('transcription', trimmedQuestion);
  }

  /**
   * Handle speaker switching detection
   */
  private handleSpeakerActivity(speaker: number | null): void {
    if (speaker === null) return;
    
    const now = Date.now();
    const lastActivity = this.lastSpeakerActivity.get(speaker) || 0;
    
    // Update activity for this speaker
    this.lastSpeakerActivity.set(speaker, now);
    
    // Check for speaker switch
    if (this.currentActiveSpeaker !== null && 
        this.currentActiveSpeaker !== speaker &&
        now - lastActivity > this.SPEAKER_SWITCH_THRESHOLD) {
      
      console.log(`Speaker switch detected: ${this.currentActiveSpeaker} -> ${speaker}`);
      
      // If we have a question buffer from interviewer and candidate starts speaking,
      // immediately process the question
      if (this.questionBuffer && 
          this.questionBuffer.speaker === 0 && // Was interviewer
          speaker === 1) { // Now candidate
        console.log('Candidate started speaking - processing interviewer question immediately');
        this.processQuestionBuffer();
      }
    }
    
    this.currentActiveSpeaker = speaker;
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
            console.log(`Transcription received (final: ${isFinal}):`, transcriptResult.transcript);
            
            if (hasDiarization && transcriptResult.words && transcriptResult.words.length > 0) {
              this.processingDiarizedTranscript = true;
              this.handleDiarizedTranscript(transcriptResult, isFinal);
            } else {
              // Handle non-diarized transcript with enhanced VAD
              this.handleNonDiarizedTranscript(transcriptResult.transcript, isFinal);
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
  
  /**
   * Handle diarized transcript with enhanced VAD
   */
  private handleDiarizedTranscript(transcriptResult: any, isFinal: boolean): void {
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
      const originalSpeaker = word.speaker !== undefined ? word.speaker : null;
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
      
      // Track speaker activity
      if (mappedSpeaker !== null) {
        this.handleSpeakerActivity(mappedSpeaker);
      }
    }
    
    if (currentText.trim() !== '') {
      speakerSegments.push({
        speaker: currentSpeaker,
        text: currentText.trim()
      });
    }
    
    // Send formatted transcript to UI
    let formattedTranscript = '';
    speakerSegments.forEach(segment => {
      const speakerName = segment.speaker === 0 ? 'Interviewer' : 'You';
      formattedTranscript += `${speakerName}: ${segment.text}\n`;
    });
    
    if (this.mainWindow) {
      this.mainWindow.webContents.send('speech-transcription', formattedTranscript.trim());
    }
    
    // Process interviewer segments with enhanced VAD
    const interviewerSegments = speakerSegments.filter(s => s.speaker === 0);
    
    if (interviewerSegments.length > 0) {
      const interviewerText = interviewerSegments.map(s => s.text).join(' ');
      this.updateQuestionBuffer(interviewerText, 0, isFinal);
    }
    
    // Reset processing flag after delay
    setTimeout(() => {
      this.processingDiarizedTranscript = false;
    }, 500);
  }

  /**
   * Handle non-diarized transcript with enhanced VAD
   */
  private handleNonDiarizedTranscript(transcript: string, isFinal: boolean): void {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('speech-transcription', transcript);
    }
    
    // If not processing diarized version, use basic VAD
    if (!this.processingDiarizedTranscript) {
      this.updateQuestionBuffer(transcript, null, isFinal);
    }
  }

  /**
   * Update question buffer with new transcript content
   */
  private updateQuestionBuffer(text: string, speaker: number | null, isFinal: boolean): void {
    const now = Date.now();
    
    if (!this.questionBuffer) {
      // Create new buffer for potential question
      if (this.isLikelyQuestion(text)) {
        this.questionBuffer = {
          text: text,
          speaker: speaker,
          lastUpdateTime: now,
          wordCount: text.split(/\s+/).length,
          hasQuestionMarkers: text.includes('?')
        };
        
        console.log('Started new question buffer:', text);
        
        // Set timer for question completion
        this.questionCompletionTimer = setTimeout(() => {
          this.processQuestionBuffer();
        }, this.QUESTION_COMPLETION_PAUSE);
      }
    } else {
      // Update existing buffer
      if (speaker === null || speaker === this.questionBuffer.speaker) {
        this.questionBuffer.text = text;
        this.questionBuffer.lastUpdateTime = now;
        this.questionBuffer.wordCount = text.split(/\s+/).length;
        this.questionBuffer.hasQuestionMarkers = text.includes('?');
        
        console.log('Updated question buffer:', text);
        
        // Reset completion timer
        if (this.questionCompletionTimer) {
          clearTimeout(this.questionCompletionTimer);
        }
        this.questionCompletionTimer = setTimeout(() => {
          this.processQuestionBuffer();
        }, this.QUESTION_COMPLETION_PAUSE);
      }
    }
    
    // If final and we have a buffer, process it
    if (isFinal && this.questionBuffer) {
      // Small delay to allow for any follow-up words
      setTimeout(() => {
        this.processQuestionBuffer();
      }, 300);
    }
  }
  
  public async stopListening(): Promise<boolean> {
    if (!this.isListening || !this.liveTcp) {
      return false;
    }
    
    try {
      this.liveTcp.finish();
      this.isListening = false;
      this.processedTranscriptIds.clear();
      this.resetVADState();
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
      
      // Check for duplicate transcript
      if (
        transcript === this.lastProcessedText && 
        now - this.lastProcessedTime < this.DEBOUNCE_TIME
      ) {
        console.log('Skipping duplicate transcript processing');
        return true;
      }
      
      // Only process if it looks like an actual question
      if (!this.isLikelyQuestion(transcript)) {
        console.log('Not processing transcript as it does not appear to be a question:', transcript);
        return true;
      }

      this.lastProcessedText = transcript;
      this.lastProcessedTime = now;

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