// SystemAudioHelper.ts
import { BrowserWindow, ipcMain, desktopCapturer } from 'electron';

export class SystemAudioHelper {
  private mainWindow: BrowserWindow;
  
  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.setupIpcHandlers();
  }
  
  /**
   * Set up IPC handlers for system audio capture
   */
  private setupIpcHandlers(): void {
    ipcMain.handle('capture-system-audio', async () => {
      return await this.captureSystemAudio();
    });
  }
  
  /**
   * Capture system audio using Electron's desktopCapturer API
   * This method returns a MediaStream object to the renderer process
   */
  private async captureSystemAudio(): Promise<string> {
    try {
      // Get available sources
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        fetchWindowIcons: false
      });
      
      // Find the first screen source (which should have system audio)
      const screenSource = sources.find(source => source.id.startsWith('screen'));
      
      if (!screenSource) {
        throw new Error('No screen source available for system audio capture');
      }
      
      // Return the source ID for the renderer process to use
      // Renderer will use navigator.mediaDevices.getUserMedia with this ID
      return screenSource.id;
    } catch (error) {
      console.error('Failed to capture system audio:', error);
      throw error;
    }
  }
}

/**
 * Initialize the SystemAudioHelper with the main window
 */
let systemAudioHelperInstance: SystemAudioHelper | null = null;
export function initializeSystemAudioHelper(mainWindow: BrowserWindow): SystemAudioHelper {
  systemAudioHelperInstance = new SystemAudioHelper(mainWindow);
  return systemAudioHelperInstance;
}

/**
 * Get the SystemAudioHelper instance
 */
export function getSystemAudioHelper(): SystemAudioHelper | null {
  return systemAudioHelperInstance;
} 