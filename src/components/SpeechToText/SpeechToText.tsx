import React, { useEffect, useState, useRef } from 'react';
import { Mic, MicOff, Settings, Headphones, RefreshCcw } from 'lucide-react';
import { COMMAND_KEY } from "../../utils/platform";

// Create a fully dynamic container without any height constraints
const containerStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '1rem',
  padding: '1rem',
  border: '1px solid rgba(226, 232, 240, 0.4)',
  borderRadius: '0.5rem',
  backgroundColor: 'rgba(15, 23, 42, 0.75)', 
  width: '100%',
  minWidth: '300px',
  height: 'auto',
  minHeight: '0',
  maxHeight: 'none !important',
  overflow: 'visible !important',
  position: 'static' as const,
};

const buttonStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '0.5rem 1rem',
  border: 'none',
  borderRadius: '0.375rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background-color 150ms ease'
};

const micButtonStyle = {
  ...buttonStyle,
  backgroundColor: 'rgba(37, 99, 235, 0.85)',
  color: 'white'
};

const micActiveButtonStyle = {
  ...micButtonStyle,
  backgroundColor: 'rgba(34, 197, 94, 0.85)',
};

const settingsButtonStyle = {
  ...buttonStyle,
  backgroundColor: 'rgba(71, 85, 105, 0.75)',
  color: 'white',
};

// Dynamic content containers with absolutely no height limits or scrolling
const transcriptContainerStyle = {
  marginTop: '1rem',
  padding: '0.75rem',
  border: '1px solid rgba(226, 232, 240, 0.4)',
  borderRadius: '0.375rem',
  backgroundColor: 'rgba(30, 41, 59, 0.8)',
  color: 'rgba(255, 255, 255, 0.95)',
  width: '100%',
  height: 'auto',
  minHeight: '0',
  maxHeight: 'none !important',
  overflow: 'visible !important',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  boxSizing: 'border-box' as const,
  position: 'static' as const,
};

const responseContainerStyle = {
  marginTop: '1rem',
  padding: '0.75rem',
  border: '1px solid rgba(34, 197, 94, 0.4)',
  borderRadius: '0.375rem',
  backgroundColor: 'rgba(20, 83, 45, 0.75)',
  color: 'rgba(255, 255, 255, 0.95)',
  width: '100%',
  height: 'auto',
  minHeight: '0',
  maxHeight: 'none !important',
  overflow: 'visible !important',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  boxSizing: 'border-box' as const,
  position: 'static' as const,
};

// Styles for different speakers
const interviewerTextStyle = {
  color: 'rgba(14, 165, 233, 0.95)',
  fontWeight: 600 as const,
  marginBottom: '0.25rem'
};

const userTextStyle = {
  color: 'rgba(34, 197, 94, 0.95)',
  fontWeight: 600 as const,
  marginBottom: '0.25rem'
};

// Error and processing styles
const errorStyle = {
  color: 'rgba(239, 68, 68, 0.95)',
  marginTop: '0.5rem',
  fontWeight: 500
};

const processingStyle = {
  color: 'rgba(59, 130, 246, 0.95)',
  marginTop: '0.5rem',
  fontWeight: 500
};

const labelStyle = {
  fontWeight: 500,
  marginBottom: '0.25rem',
  color: 'rgba(255, 255, 255, 0.9)'
};

// Toggle styles
const toggleContainerStyle = {
  display: 'flex',
  gap: '0.75rem',
  marginTop: '0.75rem'
};

const toggleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  cursor: 'pointer'
};

const toggleButtonStyle = {
  width: '2.5rem',
  height: '1.25rem',
  backgroundColor: 'rgba(71, 85, 105, 0.75)',
  borderRadius: '0.75rem',
  position: 'relative' as const,
  transition: 'background-color 150ms ease'
};

const toggleButtonActiveStyle = {
  ...toggleButtonStyle,
  backgroundColor: 'rgba(37, 99, 235, 0.85)'
};

const toggleHandleStyle = {
  width: '1rem',
  height: '1rem',
  borderRadius: '50%',
  backgroundColor: 'white',
  position: 'absolute' as const,
  top: '0.125rem',
  left: '0.125rem',
  transition: 'transform 150ms ease'
};

const toggleHandleActiveStyle = {
  ...toggleHandleStyle,
  transform: 'translateX(1.25rem)'
};

// Create a wrapper style that ensures full expansion
const wrapperStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  height: 'auto',
  minHeight: '0',
  maxHeight: 'none !important',
  overflow: 'visible !important',
  width: '100%',
  position: 'static' as const,
};

interface SpeechToTextProps {
  onSettingsOpen: () => void;
}

export function SpeechToText({ onSettingsOpen }: SpeechToTextProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Track only the current interviewer question
  const [currentQuestion, setCurrentQuestion] = useState('');
  
  // Audio source toggles
  const [useMicrophone, setUseMicrophone] = useState(true);
  const [useSystemAudio, setUseSystemAudio] = useState(false);
  
  // Refs for audio handling
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const systemAudioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  
  // Timer for transcript processing
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastTranscriptRef = useRef<string>('');
  // Add a ref to track if the current transcript has been processed
  const hasProcessedCurrentTranscriptRef = useRef<boolean>(false);
  
  // Add a ref for response container to measure height changes
  const responseRef = useRef<HTMLDivElement>(null);
  
  // Monitor response changes to update container height
  useEffect(() => {
    if (response && responseRef.current) {
      // Force the container to expand to fit content
      const updateHeight = () => {
        // Get the parent element that might need dimension updates
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
          // Trigger a resize event to make the container adjust
          window.dispatchEvent(new Event('resize'));
        }
      };
      
      // Update immediately and after a delay to ensure content is fully rendered
      updateHeight();
      const timeouts = [
        setTimeout(updateHeight, 100),
        setTimeout(updateHeight, 500),
        setTimeout(updateHeight, 1000)
      ];
      
      return () => {
        timeouts.forEach(t => clearTimeout(t));
      };
    }
  }, [response]);
  
  // Clean up audio resources
  const cleanupAudio = () => {
    try {
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
        processingTimerRef.current = null;
      }
      
      if (processorNodeRef.current) {
        processorNodeRef.current.disconnect();
        processorNodeRef.current = null;
      }
      
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
      }
      
      if (systemAudioStreamRef.current) {
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
      }
    } catch (err) {
      console.error('Error cleaning up audio resources:', err);
    }
  };

  useEffect(() => {
    // Set up event listeners for speech recognition
    const unsubscribeStarted = window.electronAPI.onSpeechRecognitionStarted(() => {
      setIsListening(true);
      setError(null);
      setIsProcessing(false);
      
      // Start capturing audio when Deepgram is ready
      startAudioCapture();
    });

    const unsubscribeStopped = window.electronAPI.onSpeechRecognitionStopped(() => {
      setIsListening(false);
      cleanupAudio();
    });

    const unsubscribeError = window.electronAPI.onSpeechRecognitionError((errorMsg: string) => {
      setIsListening(false);
      setError(errorMsg);
      cleanupAudio();
    });

    const unsubscribeTranscription = window.electronAPI.onSpeechTranscription((text: string) => {
      setTranscript(text);
      lastTranscriptRef.current = text;
      // Reset the processed flag when new transcription comes in
      hasProcessedCurrentTranscriptRef.current = false;
      
      // Extract interviewer's question if present
      if (text.includes('Interviewer:')) {
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('Interviewer:')) {
            // Extract only the most recent interviewer question
            const question = line.split('Interviewer:')[1]?.trim();
            if (question) {
              setCurrentQuestion(question);
              
              // Check if it's actually a question before auto-processing
              if (isLikelyQuestion(question)) {
                // If we have a question, we could automatically process it after a small delay
                if (processingTimerRef.current) {
                  clearTimeout(processingTimerRef.current);
                }
                processingTimerRef.current = setTimeout(() => {
                  if (!hasProcessedCurrentTranscriptRef.current) {
                    processTranscript(question);
                  }
                }, 1500); // 1.5 second delay to allow for corrections
              } else {
                console.log('Detected speech marked as Interviewer but does not appear to be a question:', question);
              }
            }
            break; // Only take the first interviewer line
          }
        }
      }
      
      // Reset processing timer on new transcription
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
      }
    });

    const unsubscribeAiResponse = window.electronAPI.onAiResponse((aiResponse: string) => {
      setResponse(aiResponse);
      setIsProcessing(false);
    });

    const unsubscribeAiError = window.electronAPI.onAiResponseError((errorMsg: string) => {
      setError(errorMsg);
      setIsProcessing(false);
    });

    return () => {
      // Clean up listeners
      unsubscribeStarted();
      unsubscribeStopped();
      unsubscribeError();
      unsubscribeTranscription();
      unsubscribeAiResponse();
      unsubscribeAiError();
      
      // Clean up audio resources
      cleanupAudio();
    };
  }, []);
  
  // Helper function to extract interviewer text
  const extractInterviewerText = (text: string): string => {
    if (!text.includes('Interviewer:')) return '';
    
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('Interviewer:')) {
        return line.split('Interviewer:')[1]?.trim() || '';
      }
    }
    return '';
  };
  
  // Function to check if text is likely a question or statement
  const isLikelyQuestion = (text: string): boolean => {
    // Check for question marks
    if (text.includes('?')) return true;
    
    // Check for common question starters
    const questionStarters = [
      'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whose', 'whom',
      'can you', 'could you', 'will you', 'would you', 'tell me', 'explain',
      'describe', 'elaborate', 'discuss', 'compare', 'can we', 'should', 'do you'
    ];
    
    const lowerText = text.toLowerCase();
    return questionStarters.some(starter => 
      lowerText.startsWith(starter + ' ') || lowerText.includes(' ' + starter + ' ')
    );
  };
  
  // Process transcript automatically when user stops speaking
  const processTranscript = async (text: string) => {
    if (text.trim() === '' || isProcessing) return;
    
    // Additional check to prevent duplicate processing
    if (hasProcessedCurrentTranscriptRef.current) {
      console.log('Skipping duplicate processing of already processed transcript');
      return;
    }
    
    // New check: only process text that looks like a question
    if (!isLikelyQuestion(text)) {
      console.log('Skipping non-question text:', text);
      return;
    }
    
    try {
      setIsProcessing(true);
      
      // Process the transcript through the API
      const result = await window.electronAPI.processTranscript(text);
      if (!result) {
        setError('Failed to process transcript');
        setIsProcessing(false);
      } else {
        // Mark this transcript as processed
        hasProcessedCurrentTranscriptRef.current = true;
      }
    } catch (err: unknown) {
      console.error('Error processing transcript:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to process transcript';
      setError(errorMessage);
      setIsProcessing(false);
    }
  };
  
  // Start capturing audio from the selected sources
  const startAudioCapture = async () => {
    try {
      // Create audio context
      const audioContext = new AudioContext({
        sampleRate: 16000 // Deepgram expects 16kHz audio
      });
      audioContextRef.current = audioContext;
      
      // Create script processor node for audio processing
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      processorNodeRef.current = processorNode;
      
      // Create a GainNode for mixing multiple audio sources
      const mixerNode = audioContext.createGain();
      
      let hasAudioSource = false;
      
      // Capture microphone if enabled
      if (useMicrophone) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          mediaStreamRef.current = micStream;
          
          const micSourceNode = audioContext.createMediaStreamSource(micStream);
          micSourceNode.connect(mixerNode);
          hasAudioSource = true;
          console.log('Microphone capture enabled');
        } catch (micErr: unknown) {
          console.error('Microphone access error:', micErr);
          if (!useSystemAudio) {
            const errorMessage = micErr instanceof Error ? micErr.message : 'Unknown microphone access error';
            throw new Error(`Microphone access error: ${errorMessage}`);
          }
        }
      }
      
      // Capture system audio if enabled
      if (useSystemAudio) {
        try {
          // Request system audio source ID from the main process
          const sourceId = await window.electronAPI.captureSystemAudio();
          
          if (sourceId) {
            // Use the returned source ID to capture the system audio
            const systemStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                // For Electron-specific constraints, we need to use proper typing
                // Define an interface that extends MediaTrackConstraints for the Electron-specific properties
                ...(({
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                  }
                } as unknown) as MediaTrackConstraints)
              },
              video: false
            });
            
            systemAudioStreamRef.current = systemStream;
            
            const systemSourceNode = audioContext.createMediaStreamSource(systemStream);
            systemSourceNode.connect(mixerNode);
            hasAudioSource = true;
            console.log('System audio capture enabled');
          } else {
            throw new Error('Failed to get system audio source');
          }
        } catch (sysErr: unknown) {
          console.error('System audio access error:', sysErr);
          if (!useMicrophone || !mediaStreamRef.current) {
            const errorMessage = sysErr instanceof Error ? sysErr.message : 'Unknown system audio access error';
            throw new Error(`System audio access error: ${errorMessage}`);
          }
        }
      }
      
      // If no audio source could be captured, throw an error
      if (!hasAudioSource) {
        throw new Error('No audio source available. Please enable at least one audio source.');
      }
      
      // Connect mixer to processor node
      mixerNode.connect(processorNode);
      
      // Process audio data
      processorNode.onaudioprocess = (event) => {
        // Get audio data
        const inputData = event.inputBuffer.getChannelData(0);
        
        // Convert float32 audio data to 16-bit PCM
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.min(1, Math.max(-1, inputData[i])) * 0x7fff;
        }
        
        // Send audio data to main process
        window.electronAPI.sendAudioData(pcmData.buffer);
      };
      
      // Connect processor to destination
      processorNode.connect(audioContext.destination);
      
      console.log('Audio capture started');
    } catch (err: unknown) {
      console.error('Error starting audio capture:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown audio access error';
      setError(`Audio access error: ${errorMessage}`);
      setIsListening(false);
      await window.electronAPI.stopSpeechRecognition();
    }
  };

  const toggleListening = async () => {
    try {
      // Check if at least one audio source is selected
      if (!isListening && !useMicrophone && !useSystemAudio) {
        setError('Please enable at least one audio source (microphone or system audio).');
        return;
      }
      
      if (isListening) {
        // If we're stopping, process any final transcript ONLY if it hasn't been processed yet
        if (lastTranscriptRef.current && 
            lastTranscriptRef.current.trim() !== '' && 
            !hasProcessedCurrentTranscriptRef.current) {
          if (lastTranscriptRef.current.includes('Interviewer:')) {
            const interviewerText = extractInterviewerText(lastTranscriptRef.current);
            if (interviewerText && isLikelyQuestion(interviewerText)) {
              processTranscript(interviewerText);
            } else {
              console.log('Final transcript does not appear to be a question, skipping processing');
            }
          }
        }
        
        await window.electronAPI.stopSpeechRecognition();
        cleanupAudio();
      } else {
        // Clear previous transcript and response when starting a new session
        setTranscript('');
        setCurrentQuestion('');
        setResponse('');
        setError(null);
        setIsProcessing(false);
        lastTranscriptRef.current = '';
        hasProcessedCurrentTranscriptRef.current = false;
        await window.electronAPI.startSpeechRecognition();
        // Audio capture will be started when we receive the onSpeechRecognitionStarted event
      }
    } catch (err: unknown) {
      console.error('Error toggling speech recognition:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage || 'Failed to toggle speech recognition');
    }
  };
  
  // Toggle functions for audio sources
  const toggleMicrophone = () => {
    if (isListening) {
      setError('Please stop listening before changing audio sources.');
      return;
    }
    setUseMicrophone(!useMicrophone);
  };
  
  const toggleSystemAudio = () => {
    if (isListening) {
      setError('Please stop listening before changing audio sources.');
      return;
    }
    setUseSystemAudio(!useSystemAudio);
  };

  return (
    <div className="pt-2 w-fit">
      <div className="text-xs text-white/90 backdrop-blur-md bg-black/60 rounded-lg py-2 px-4 flex items-center justify-center gap-4">
        {/* Listen/Stop Button */}
        <div
          className={`flex items-center gap-2 cursor-pointer rounded px-2 py-1.5 hover:bg-white/10 transition-colors ${
            (!useMicrophone && !useSystemAudio) ? "opacity-50 cursor-not-allowed" : ""
          }`}
          onClick={toggleListening}
        >
          <span className="text-[11px] leading-none truncate">
            {isListening ? "Stop Listening" : "Start Listening"}
          </span>
          <div className="flex gap-1">
            <button className="bg-white/10 rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
              {COMMAND_KEY}
            </button>
            <button className="bg-white/10 rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
              M
            </button>
          </div>
        </div>

        {/* Audio Source Controls */}
        <div className="flex items-center gap-3">
          {/* Microphone Toggle */}
          <div
            className={`flex items-center gap-1.5 cursor-pointer rounded px-2 py-1 hover:bg-white/10 transition-colors ${
              isListening ? "opacity-50 cursor-not-allowed" : ""
            }`}
            onClick={toggleMicrophone}
          >
            <Mic size={12} className={useMicrophone ? "text-blue-400" : "text-white/50"} />
            <span className={`text-[11px] leading-none ${useMicrophone ? "text-blue-400" : "text-white/50"}`}>
              Mic
            </span>
          </div>

          {/* System Audio Toggle */}
          <div
            className={`flex items-center gap-1.5 cursor-pointer rounded px-2 py-1 hover:bg-white/10 transition-colors ${
              isListening ? "opacity-50 cursor-not-allowed" : ""
            }`}
            onClick={toggleSystemAudio}
          >
            <Headphones size={12} className={useSystemAudio ? "text-blue-400" : "text-white/50"} />
            <span className={`text-[11px] leading-none ${useSystemAudio ? "text-blue-400" : "text-white/50"}`}>
              System
            </span>
          </div>
        </div>

        {/* Separator */}
        <div className="mx-1 h-4 w-px bg-white/20" />

        {/* Settings Button */}
        <div
          className="flex items-center gap-1.5 cursor-pointer rounded px-2 py-1 hover:bg-white/10 transition-colors"
          onClick={onSettingsOpen}
        >
          <Settings size={12} className="text-white/70" />
          <span className="text-[11px] leading-none text-white/70">
            Settings
          </span>
        </div>

        {/* Clear History Button */}
        <div
          className="flex items-center gap-1.5 cursor-pointer rounded px-2 py-1 hover:bg-white/10 transition-colors"
          onClick={() => {
            window.electronAPI.clearConversationHistory()
              .then(() => {
                setResponse('Conversation history cleared.');
                setTimeout(() => setResponse(''), 2000);
              })
              .catch((err: unknown) => {
                console.error('Failed to clear conversation history:', err);
              });
          }}
        >
          <RefreshCcw size={12} className="text-white/70" />
          <span className="text-[11px] leading-none text-white/70">
            Clear
          </span>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mt-2 text-xs text-red-400 bg-red-900/20 backdrop-blur-md rounded-lg py-2 px-4">
          Error: {error}
        </div>
      )}

      {/* Current Question Display */}
      {currentQuestion && (
        <div className="mt-2 text-xs text-white/90 backdrop-blur-md bg-black/60 rounded-lg py-2 px-4">
          <div className="font-medium text-blue-400 mb-1">Current Question:</div>
          <div className="text-white/90 whitespace-pre-wrap break-words">
            {currentQuestion}
            {isProcessing && !response && (
              <div className="mt-1 text-blue-400 text-[11px]">
                Processing question...
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI Response Display - with dynamic height */}
      {response && (
        <div 
          ref={responseRef}
          className="mt-2 text-xs text-white/90 backdrop-blur-md bg-green-900/20 rounded-lg py-2 px-4 w-full max-w-[800px]"
        >
          <div className="font-medium text-green-400 mb-1">Answer:</div>
          <div className="text-white/90 whitespace-pre-wrap break-words">
            {response}
          </div>
        </div>
      )}
    </div>
  );
} 