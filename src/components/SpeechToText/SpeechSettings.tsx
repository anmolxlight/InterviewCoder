import React, { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

// Styles
const overlayStyle = {
  backgroundColor: 'rgba(0, 0, 0, 0.4)',
  position: 'fixed' as const,
  inset: 0,
  animation: 'overlayShow 150ms cubic-bezier(0.16, 1, 0.3, 1)'
};

const contentStyle = {
  backgroundColor: 'white',
  borderRadius: '0.375rem',
  boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
  position: 'fixed' as const,
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: '90vw',
  maxWidth: '450px',
  maxHeight: '85vh',
  padding: '1.5rem',
  animation: 'contentShow 150ms cubic-bezier(0.16, 1, 0.3, 1)'
};

const closeButtonStyle = {
  position: 'absolute' as const,
  top: '0.75rem',
  right: '0.75rem',
  width: '1.5rem',
  height: '1.5rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '100%',
  color: '#64748b',
  cursor: 'pointer',
  border: 'none',
  backgroundColor: 'transparent'
};

const formStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '1rem'
};

const labelStyle = {
  fontSize: '0.875rem',
  fontWeight: 500,
  marginBottom: '0.25rem'
};

const inputStyle = {
  padding: '0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #e2e8f0',
  width: '100%'
};

const buttonStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0.5rem 1rem',
  border: 'none',
  borderRadius: '0.375rem',
  fontWeight: 500,
  backgroundColor: '#1e40af',
  color: 'white',
  cursor: 'pointer'
};

const toggleContainerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center'
};

const toggleStyle = (enabled: boolean) => ({
  position: 'relative' as const,
  width: '3rem',
  height: '1.5rem',
  borderRadius: '9999px',
  backgroundColor: enabled ? '#1e40af' : '#cbd5e1',
  transition: 'background-color 0.2s',
  cursor: 'pointer'
});

const toggleHandleStyle = (enabled: boolean) => ({
  position: 'absolute' as const,
  left: enabled ? 'calc(100% - 1.5rem)' : '0',
  top: '0',
  width: '1.5rem',
  height: '1.5rem',
  borderRadius: '50%',
  backgroundColor: 'white',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
  transition: 'left 0.2s'
});

interface SpeechSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SpeechSettings({ open, onOpenChange }: SpeechSettingsProps) {
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load settings on component mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        // Get extended config from main process
        const extendedConfig = await window.electronAPI.getExtendedConfig();
        if (extendedConfig) {
          setApiKey(extendedConfig.deepgramApiKey || '');
          setEnabled(extendedConfig.speechToTextEnabled || false);
        }
      } catch (err) {
        console.error('Error loading speech settings:', err);
      }
    };

    if (open) {
      loadSettings();
    }
  }, [open]);

  // Handle save button click
  const handleSave = async () => {
    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Test API key first
      if (apiKey) {
        const testResult = await window.electronAPI.testDeepgramKey(apiKey);
        if (!testResult.valid) {
          setError(testResult.error || 'Invalid Deepgram API key');
          setIsLoading(false);
          return;
        }
      }

      // Update API key
      if (apiKey) {
        await window.electronAPI.updateDeepgramKey(apiKey);
      }

      // Toggle speech recognition
      await window.electronAPI.toggleSpeechRecognition(enabled);

      setSuccess('Speech settings saved successfully');
    } catch (err) {
      console.error('Error saving speech settings:', err);
      setError(err.message || 'Failed to save settings');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={overlayStyle} />
        <Dialog.Content style={contentStyle}>
          <Dialog.Title style={{ marginBottom: '1rem', fontWeight: 600 }}>
            Speech-to-Text Settings
          </Dialog.Title>
          
          <Dialog.Description style={{ marginBottom: '1.5rem', color: '#64748b' }}>
            Configure your Deepgram API key and speech-to-text settings.
          </Dialog.Description>
          
          <form style={formStyle} onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
            <div>
              <label style={labelStyle} htmlFor="deepgram-api-key">
                Deepgram API Key
              </label>
              <input
                id="deepgram-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                style={inputStyle}
                placeholder="Enter your Deepgram API key"
              />
            </div>
            
            <div style={toggleContainerStyle}>
              <label style={labelStyle}>Enable Speech-to-Text</label>
              <div 
                style={toggleStyle(enabled)} 
                onClick={() => setEnabled(!enabled)}
                role="switch"
                aria-checked={enabled}
              >
                <div style={toggleHandleStyle(enabled)} />
              </div>
            </div>
            
            {error && (
              <div style={{ color: 'red', marginTop: '0.5rem' }}>
                {error}
              </div>
            )}
            
            {success && (
              <div style={{ color: 'green', marginTop: '0.5rem' }}>
                {success}
              </div>
            )}
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <Dialog.Close asChild>
                <button type="button" style={{ ...buttonStyle, backgroundColor: '#f1f5f9', color: '#1e293b' }}>
                  Cancel
                </button>
              </Dialog.Close>
              <button 
                type="submit" 
                style={buttonStyle}
                disabled={isLoading}
              >
                {isLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
          
          <Dialog.Close asChild>
            <button style={closeButtonStyle} aria-label="Close">
              <X size={18} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
} 