import React, { useEffect, useState, useRef } from 'react';
import { Mic, MicOff, Settings, Speaker, Headphones } from 'lucide-react';

// Updated styles for dark transparent theme
const containerStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '1rem',
  padding: '1rem',
  border: '1px solid rgba(226, 232, 240, 0.4)',
  borderRadius: '0.5rem',
  backgroundColor: 'rgba(15, 23, 42, 0.75)'  // Darker background with higher opacity
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
  backgroundColor: 'rgba(37, 99, 235, 0.85)', // Brighter blue with higher opacity
  color: 'white'
};

const micActiveButtonStyle = {
  ...micButtonStyle,
  backgroundColor: 'rgba(34, 197, 94, 0.85)', // Brighter green with higher opacity
};

const settingsButtonStyle = {
  ...buttonStyle,
  backgroundColor: 'rgba(71, 85, 105, 0.75)', // Darker background with higher opacity
  color: 'white',
};

const transcriptContainerStyle = {
  marginTop: '1rem',
  padding: '0.5rem',
  border: '1px solid rgba(226, 232, 240, 0.4)',
  borderRadius: '0.375rem',
  backgroundColor: 'rgba(30, 41, 59, 0.8)', // Dark slate with higher opacity
  color: 'rgba(255, 255, 255, 0.95)', // Almost white text
  minHeight: '3rem',
  maxHeight: '8rem',
  overflowY: 'auto' as const
};

const responseContainerStyle = {
  marginTop: '1rem',
  padding: '0.5rem',
  border: '1px solid rgba(34, 197, 94, 0.4)',
  borderRadius: '0.375rem',
  backgroundColor: 'rgba(20, 83, 45, 0.75)', // Dark green with higher opacity
  color: 'rgba(255, 255, 255, 0.95)', // Almost white text
  minHeight: '3rem',
  maxHeight: '8rem',
  overflowY: 'auto' as const
};

// Update the error and success styles
const errorStyle = {
  color: 'rgba(239, 68, 68, 0.95)', // Brighter red with high opacity
  marginTop: '0.5rem',
  fontWeight: 500
};

const processingStyle = {
  color: 'rgba(59, 130, 246, 0.95)', // Bright blue with high opacity
  marginTop: '0.5rem',
  fontWeight: 500
};

const labelStyle = {
  fontWeight: 500,
  marginBottom: '0.25rem',
  color: 'rgba(255, 255, 255, 0.9)' // Almost white text
};

// New toggle style for audio source selection
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

interface SpeechToTextProps {
  onSettingsOpen: () => void;
}

export function SpeechToText({ onSettingsOpen }: SpeechToTextProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
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

    const unsubscribeError = window.electronAPI.onSpeechRecognitionError((errorMsg) => {
      setIsListening(false);
      setError(errorMsg);
      cleanupAudio();
    });

    const unsubscribeTranscription = window.electronAPI.onSpeechTranscription((text) => {
      setTranscript(text);
      lastTranscriptRef.current = text;
      
      // Reset processing timer on new transcription
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
      }
      
      // Start a new timer - if no new transcription after 1.5 seconds, process it
      processingTimerRef.current = setTimeout(() => {
        if (text.trim() !== '') {
          processTranscript(text);
        }
      }, 1500);
    });

    const unsubscribeAiResponse = window.electronAPI.onAiResponse((aiResponse) => {
      setResponse(aiResponse);
      setIsProcessing(false);
    });

    const unsubscribeAiError = window.electronAPI.onAiResponseError((errorMsg) => {
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
  
  // Process transcript automatically when user stops speaking
  const processTranscript = async (text: string) => {
    if (text.trim() === '' || isProcessing) return;
    
    try {
      setIsProcessing(true);
      
      // Process the transcript through the API
      const result = await window.electronAPI.processTranscript(text);
      if (!result) {
        setError('Failed to process transcript');
        setIsProcessing(false);
      }
    } catch (err) {
      console.error('Error processing transcript:', err);
      setError(err.message || 'Failed to process transcript');
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
        } catch (micErr) {
          console.error('Microphone access error:', micErr);
          if (!useSystemAudio) {
            throw new Error(`Microphone access error: ${micErr.message}`);
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
                mandatory: {
                  chromeMediaSource: 'desktop',
                  chromeMediaSourceId: sourceId
                } as any
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
        } catch (sysErr) {
          console.error('System audio access error:', sysErr);
          if (!useMicrophone || !mediaStreamRef.current) {
            throw new Error(`System audio access error: ${sysErr.message}`);
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
    } catch (err) {
      console.error('Error starting audio capture:', err);
      setError(`Audio access error: ${err.message}`);
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
        // If we're stopping, process any final transcript
        if (lastTranscriptRef.current && lastTranscriptRef.current.trim() !== '') {
          processTranscript(lastTranscriptRef.current);
        }
        
        await window.electronAPI.stopSpeechRecognition();
        cleanupAudio();
      } else {
        // Clear previous transcript and response when starting a new session
        setTranscript('');
        setResponse('');
        setError(null);
        setIsProcessing(false);
        lastTranscriptRef.current = '';
        await window.electronAPI.startSpeechRecognition();
        // Audio capture will be started when we receive the onSpeechRecognitionStarted event
      }
    } catch (err) {
      console.error('Error toggling speech recognition:', err);
      setError(err.message || 'Failed to toggle speech recognition');
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
    <div style={containerStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <button 
          onClick={toggleListening} 
          style={isListening ? micActiveButtonStyle : micButtonStyle}
          disabled={(!!error && !isListening) || (!useMicrophone && !useSystemAudio)}
        >
          {isListening ? (
            <>
              <MicOff size={18} />
              Stop Listening
            </>
          ) : (
            <>
              <Mic size={18} />
              Start Listening
            </>
          )}
        </button>
        
        <button onClick={onSettingsOpen} style={settingsButtonStyle}>
          <Settings size={18} />
          Settings
        </button>
      </div>
      
      {/* Audio source toggles */}
      <div style={toggleContainerStyle}>
        <div style={toggleStyle} onClick={toggleMicrophone}>
          <div style={useMicrophone ? toggleButtonActiveStyle : toggleButtonStyle}>
            <div style={useMicrophone ? toggleHandleActiveStyle : toggleHandleStyle} />
          </div>
          <Mic size={18} />
          <span style={labelStyle}>Microphone</span>
        </div>
        
        <div style={toggleStyle} onClick={toggleSystemAudio}>
          <div style={useSystemAudio ? toggleButtonActiveStyle : toggleButtonStyle}>
            <div style={useSystemAudio ? toggleHandleActiveStyle : toggleHandleStyle} />
          </div>
          <Headphones size={18} />
          <span style={labelStyle}>System Audio</span>
        </div>
      </div>
      
      {error && (
        <div style={errorStyle}>
          Error: {error}
        </div>
      )}
      
      <div>
        <div style={labelStyle}>Transcript:</div>
        <div style={transcriptContainerStyle}>
          {transcript || 'No transcript yet. Click "Start Listening" to begin.'}
          {isProcessing && (
            <div style={processingStyle}>
              Processing transcript...
            </div>
          )}
        </div>
      </div>
      
      {response && (
        <div>
          <div style={labelStyle}>AI Response:</div>
          <div style={responseContainerStyle}>
            {response}
          </div>
        </div>
      )}
    </div>
  );
} 