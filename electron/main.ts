import { app, BrowserWindow, screen, shell, ipcMain } from "electron"
import path from "path"
import fs from "fs"
import { initializeIpcHandlers } from "./ipcHandlers"
import { ProcessingHelper } from "./ProcessingHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { ShortcutsHelper } from "./shortcuts"
import { initAutoUpdater } from "./autoUpdater"
import { configHelper } from "./ConfigHelper"
import * as dotenv from "dotenv"
import { initializeSpeechToTextHelper, getSpeechToTextHelper } from './SpeechToTextHelper'
import { initializeSystemAudioHelper, getSystemAudioHelper } from './SystemAudioHelper'

// Constants
const isDev = process.env.NODE_ENV === "development"

// Application State
const state = {
  // Window management properties
  mainWindow: null as BrowserWindow | null,
  isWindowVisible: false,
  windowPosition: null as { x: number; y: number } | null,
  windowSize: null as { width: number; height: number } | null,
  screenWidth: 0,
  screenHeight: 0,
  step: 0,
  currentX: 0,
  currentY: 0,

  // Application helpers
  screenshotHelper: null as ScreenshotHelper | null,
  shortcutsHelper: null as ShortcutsHelper | null,
  processingHelper: null as ProcessingHelper | null,

  // View and state management
  view: "queue" as "queue" | "solutions" | "debug",
  problemInfo: null as any,
  hasDebugged: false,

  // Processing events
  PROCESSING_EVENTS: {
    UNAUTHORIZED: "processing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",
    OUT_OF_CREDITS: "out-of-credits",
    API_KEY_INVALID: "api-key-invalid",
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const
}

// Add interfaces for helper classes
export interface IProcessingHelperDeps {
  getScreenshotHelper: () => ScreenshotHelper | null
  getMainWindow: () => BrowserWindow | null
  getView: () => "queue" | "solutions" | "debug"
  setView: (view: "queue" | "solutions" | "debug") => void
  getProblemInfo: () => any
  setProblemInfo: (info: any) => void
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  clearQueues: () => void
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  setHasDebugged: (value: boolean) => void
  getHasDebugged: () => boolean
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
}

export interface IShortcutsHelperDeps {
  getMainWindow: () => BrowserWindow | null
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  processingHelper: ProcessingHelper | null
  clearQueues: () => void
  setView: (view: "queue" | "solutions" | "debug") => void
  isVisible: () => boolean
  toggleMainWindow: () => void
  moveWindowLeft: () => void
  moveWindowRight: () => void
  moveWindowUp: () => void
  moveWindowDown: () => void
}

export interface IIpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null
  setWindowDimensions: (width: number, height: number) => void
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  getImagePreview: (filepath: string) => Promise<string>
  processingHelper: ProcessingHelper | null
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
  takeScreenshot: () => Promise<string>
  getView: () => "queue" | "solutions" | "debug"
  toggleMainWindow: () => void
  clearQueues: () => void
  setView: (view: "queue" | "solutions" | "debug") => void
  moveWindowLeft: () => void
  moveWindowRight: () => void
  moveWindowUp: () => void
  moveWindowDown: () => void
}

// Add these variables at the top of the file with the other state variables
let lastProcessedText = '';
let lastProcessedTime = 0;
const DEBOUNCE_TIME = 5000; // 5 seconds
let isCurrentlyProcessing = false; // Add a processing lock
let processingQueue: string[] = []; // Queue for pending transcripts

// Initialize helpers
function initializeHelpers() {
  state.screenshotHelper = new ScreenshotHelper(state.view)
  state.processingHelper = new ProcessingHelper({
    getScreenshotHelper,
    getMainWindow,
    getView,
    setView,
    getProblemInfo,
    setProblemInfo,
    getScreenshotQueue,
    getExtraScreenshotQueue,
    clearQueues,
    takeScreenshot,
    getImagePreview,
    deleteScreenshot,
    setHasDebugged,
    getHasDebugged,
    PROCESSING_EVENTS: state.PROCESSING_EVENTS
  } as IProcessingHelperDeps)
  state.shortcutsHelper = new ShortcutsHelper({
    getMainWindow,
    takeScreenshot,
    getImagePreview,
    processingHelper: state.processingHelper,
    clearQueues,
    setView,
    isVisible: () => state.isWindowVisible,
    toggleMainWindow,
    moveWindowLeft: () =>
      moveWindowHorizontal((x) =>
        Math.max(-(state.windowSize?.width || 0) / 2, x - state.step)
      ),
    moveWindowRight: () =>
      moveWindowHorizontal((x) =>
        Math.min(
          state.screenWidth - (state.windowSize?.width || 0) / 2,
          x + state.step
        )
      ),
    moveWindowUp: () => moveWindowVertical((y) => y - state.step),
    moveWindowDown: () => moveWindowVertical((y) => y + state.step)
  } as IShortcutsHelperDeps)
}

// Auth callback handler

// Register the interview-coder protocol
if (process.platform === "darwin") {
  app.setAsDefaultProtocolClient("interview-coder")
} else {
  app.setAsDefaultProtocolClient("interview-coder", process.execPath, [
    path.resolve(process.argv[1] || "")
  ])
}

// Handle the protocol. In this case, we choose to show an Error Box.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient("interview-coder", process.execPath, [
    path.resolve(process.argv[1])
  ])
}

// Force Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", (event, commandLine) => {
    // Someone tried to run a second instance, we should focus our window.
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore()
      state.mainWindow.focus()

      // Protocol handler removed - no longer using auth callbacks
    }
  })
}

// Auth callback removed as we no longer use Supabase authentication

// Window management functions
async function createWindow(): Promise<void> {
  if (state.mainWindow) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore()
    state.mainWindow.focus()
    return
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workAreaSize
  state.screenWidth = workArea.width
  state.screenHeight = workArea.height
  state.step = 60
  state.currentY = 50

  const windowSettings: Electron.BrowserWindowConstructorOptions = {
    width: 800,
    height: 600,
    minWidth: 750,
    minHeight: 550,
    x: state.currentX,
    y: 50,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: isDev
        ? path.join(__dirname, "../dist-electron/preload.js")
        : path.join(__dirname, "preload.js"),
      scrollBounce: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
    show: true,
    frame: false,
    transparent: true,
    fullscreenable: false,
    hasShadow: false,
    opacity: 1.0,  // Start with full opacity
    backgroundColor: "#00000000",
    focusable: true,
    skipTaskbar: true,
    type: "panel",
    paintWhenInitiallyHidden: true,
    titleBarStyle: "hidden",
    enableLargerThanScreen: true,
    movable: true,
    resizable: true,
  }

  state.mainWindow = new BrowserWindow(windowSettings)

  // Add more detailed logging for window events
  state.mainWindow.webContents.on("did-finish-load", () => {
    console.log("Window finished loading")
  })
  state.mainWindow.webContents.on(
    "did-fail-load",
    async (event, errorCode, errorDescription) => {
      console.error("Window failed to load:", errorCode, errorDescription)
      if (isDev) {
        // In development, retry loading after a short delay
        console.log("Retrying to load development server...")
        setTimeout(() => {
          state.mainWindow?.loadURL("http://localhost:54321").catch((error) => {
            console.error("Failed to load dev server on retry:", error)
          })
        }, 1000)
      }
    }
  )

  if (isDev) {
    // In development, load from the dev server
    console.log("Loading from development server: http://localhost:54321")
    state.mainWindow.loadURL("http://localhost:54321").catch((error) => {
      console.error("Failed to load dev server, falling back to local file:", error)
      // Fallback to local file if dev server is not available
      const indexPath = path.join(__dirname, "../dist/index.html")
      console.log("Falling back to:", indexPath)
      if (fs.existsSync(indexPath)) {
        state.mainWindow.loadFile(indexPath)
      } else {
        console.error("Could not find index.html in dist folder")
      }
    })
  } else {
    // In production, load from the built files
    const indexPath = path.join(__dirname, "../dist/index.html")
    console.log("Loading production build:", indexPath)
    
    if (fs.existsSync(indexPath)) {
      state.mainWindow.loadFile(indexPath)
    } else {
      console.error("Could not find index.html in dist folder")
    }
  }

  // Configure window behavior
  state.mainWindow.webContents.setZoomFactor(1)
  if (isDev) {
    state.mainWindow.webContents.openDevTools()
  }
  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log("Attempting to open URL:", url)
    if (url.includes("google.com") || url.includes("supabase.co")) {
      shell.openExternal(url)
      return { action: "deny" }
    }
    return { action: "allow" }
  })

  // Enhanced screen capture resistance
  state.mainWindow.setContentProtection(true)

  state.mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  })
  state.mainWindow.setAlwaysOnTop(true, "screen-saver", 1)

  // Additional screen capture resistance settings
  if (process.platform === "darwin") {
    // Prevent window from being captured in screenshots
    state.mainWindow.setHiddenInMissionControl(true)
    state.mainWindow.setWindowButtonVisibility(false)
    state.mainWindow.setBackgroundColor("#00000000")

    // Prevent window from being included in window switcher
    state.mainWindow.setSkipTaskbar(true)

    // Disable window shadow
    state.mainWindow.setHasShadow(false)
  }

  // Prevent the window from being captured by screen recording
  state.mainWindow.webContents.setBackgroundThrottling(false)
  state.mainWindow.webContents.setFrameRate(60)

  // Set up window listeners
  state.mainWindow.on("move", handleWindowMove)
  state.mainWindow.on("resize", handleWindowResize)
  state.mainWindow.on("closed", handleWindowClosed)

  // Initialize window state
  const bounds = state.mainWindow.getBounds()
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.windowSize = { width: bounds.width, height: bounds.height }
  state.currentX = bounds.x
  state.currentY = bounds.y
  state.isWindowVisible = true
  
  // Set opacity based on user preferences or hide initially
  // Ensure the window is visible for the first launch or if opacity > 0.1
  const savedOpacity = configHelper.getOpacity();
  console.log(`Initial opacity from config: ${savedOpacity}`);
  
  // Always make sure window is shown first
  state.mainWindow.showInactive(); // Use showInactive for consistency
  
  if (savedOpacity <= 0.1) {
    console.log('Initial opacity too low, setting to 0 and hiding window');
    state.mainWindow.setOpacity(0);
    state.isWindowVisible = false;
  } else {
    console.log(`Setting initial opacity to ${savedOpacity}`);
    state.mainWindow.setOpacity(savedOpacity);
    state.isWindowVisible = true;
  }
}

function handleWindowMove(): void {
  if (!state.mainWindow) return
  const bounds = state.mainWindow.getBounds()
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.currentX = bounds.x
  state.currentY = bounds.y
}

function handleWindowResize(): void {
  if (!state.mainWindow) return
  const bounds = state.mainWindow.getBounds()
  state.windowSize = { width: bounds.width, height: bounds.height }
}

function handleWindowClosed(): void {
  state.mainWindow = null
  state.isWindowVisible = false
  state.windowPosition = null
  state.windowSize = null
}

// Window visibility functions
function hideMainWindow(): void {
  if (!state.mainWindow?.isDestroyed()) {
    const bounds = state.mainWindow.getBounds();
    state.windowPosition = { x: bounds.x, y: bounds.y };
    state.windowSize = { width: bounds.width, height: bounds.height };
    state.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    state.mainWindow.setOpacity(0);
    state.isWindowVisible = false;
    console.log('Window hidden, opacity set to 0');
  }
}

function showMainWindow(): void {
  if (!state.mainWindow?.isDestroyed()) {
    if (state.windowPosition && state.windowSize) {
      state.mainWindow.setBounds({
        ...state.windowPosition,
        ...state.windowSize
      });
    }
    state.mainWindow.setIgnoreMouseEvents(false);
    state.mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    state.mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true
    });
    state.mainWindow.setContentProtection(true);
    state.mainWindow.setOpacity(0); // Set opacity to 0 before showing
    state.mainWindow.showInactive(); // Use showInactive instead of show+focus
    state.mainWindow.setOpacity(1); // Then set opacity to 1 after showing
    state.isWindowVisible = true;
    console.log('Window shown with showInactive(), opacity set to 1');
  }
}

function toggleMainWindow(): void {
  console.log(`Toggling window. Current state: ${state.isWindowVisible ? 'visible' : 'hidden'}`);
  if (state.isWindowVisible) {
    hideMainWindow();
  } else {
    showMainWindow();
  }
}

// Window movement functions
function moveWindowHorizontal(updateFn: (x: number) => number): void {
  if (!state.mainWindow) return
  state.currentX = updateFn(state.currentX)
  state.mainWindow.setPosition(
    Math.round(state.currentX),
    Math.round(state.currentY)
  )
}

function moveWindowVertical(updateFn: (y: number) => number): void {
  if (!state.mainWindow) return

  const newY = updateFn(state.currentY)
  // Allow window to go 2/3 off screen in either direction
  const maxUpLimit = (-(state.windowSize?.height || 0) * 2) / 3
  const maxDownLimit =
    state.screenHeight + ((state.windowSize?.height || 0) * 2) / 3

  // Log the current state and limits
  console.log({
    newY,
    maxUpLimit,
    maxDownLimit,
    screenHeight: state.screenHeight,
    windowHeight: state.windowSize?.height,
    currentY: state.currentY
  })

  // Only update if within bounds
  if (newY >= maxUpLimit && newY <= maxDownLimit) {
    state.currentY = newY
    state.mainWindow.setPosition(
      Math.round(state.currentX),
      Math.round(state.currentY)
    )
  }
}

// Window dimension functions
function setWindowDimensions(width: number, height: number): void {
  if (!state.mainWindow?.isDestroyed()) {
    const [currentX, currentY] = state.mainWindow.getPosition()
    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    const maxWidth = Math.floor(workArea.width * 0.5)

    state.mainWindow.setBounds({
      x: Math.min(currentX, workArea.width - maxWidth),
      y: currentY,
      width: Math.min(width + 32, maxWidth),
      height: Math.ceil(height)
    })
  }
}

// Environment setup
function loadEnvVariables() {
  if (isDev) {
    console.log("Loading env variables from:", path.join(process.cwd(), ".env"))
    dotenv.config({ path: path.join(process.cwd(), ".env") })
  } else {
    console.log(
      "Loading env variables from:",
      path.join(process.resourcesPath, ".env")
    )
    dotenv.config({ path: path.join(process.resourcesPath, ".env") })
  }
  console.log("Environment variables loaded for open-source version")
}

// Initialize application
async function initializeApp() {
  try {
    // Set custom cache directory to prevent permission issues
    const appDataPath = path.join(app.getPath('appData'), 'interview-coder-v1')
    const sessionPath = path.join(appDataPath, 'session')
    const tempPath = path.join(appDataPath, 'temp')
    const cachePath = path.join(appDataPath, 'cache')
    
    // Create directories if they don't exist
    for (const dir of [appDataPath, sessionPath, tempPath, cachePath]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    
    app.setPath('userData', appDataPath)
    app.setPath('sessionData', sessionPath)      
    app.setPath('temp', tempPath)
    app.setPath('cache', cachePath)
      
    loadEnvVariables()
    
    // Ensure a configuration file exists
    if (!configHelper.hasApiKey()) {
      console.log("No API key found in configuration. User will need to set up.")
    }
    
    initializeHelpers()
    initializeIpcHandlers({
      getMainWindow,
      setWindowDimensions,
      getScreenshotQueue,
      getExtraScreenshotQueue,
      deleteScreenshot,
      getImagePreview,
      processingHelper: state.processingHelper,
      PROCESSING_EVENTS: state.PROCESSING_EVENTS,
      takeScreenshot,
      getView,
      toggleMainWindow,
      clearQueues,
      setView,
      moveWindowLeft: () =>
        moveWindowHorizontal((x) =>
          Math.max(-(state.windowSize?.width || 0) / 2, x - state.step)
        ),
      moveWindowRight: () =>
        moveWindowHorizontal((x) =>
          Math.min(
            state.screenWidth - (state.windowSize?.width || 0) / 2,
            x + state.step
          )
        ),
      moveWindowUp: () => moveWindowVertical((y) => y - state.step),
      moveWindowDown: () => moveWindowVertical((y) => y + state.step)
    })
    await createWindow()
    state.shortcutsHelper?.registerGlobalShortcuts()

    // Initialize auto-updater regardless of environment
    initAutoUpdater()
    console.log(
      "Auto-updater initialized in",
      isDev ? "development" : "production",
      "mode"
    )

    // Initialize speech-to-text helper
    if (state.mainWindow) {
      const speechToTextHelper = initializeSpeechToTextHelper(state.mainWindow);
      
      // Load any saved conversation history
      if (state.processingHelper) {
        state.processingHelper.loadConversationHistory()
          .catch(err => console.error('Failed to load conversation history:', err));
      }
      
      // Setup handler for speech transcriptions
      speechToTextHelper.on('transcription', (transcript: string) => {
        handleSpeechTranscription(transcript);
      });
      
      // Initialize system audio helper
      initializeSystemAudioHelper(state.mainWindow);
    }
  } catch (error) {
    console.error("Failed to initialize application:", error)
    app.quit()
  }
}

// Auth callback handling removed - no longer needed
app.on("open-url", (event, url) => {
  console.log("open-url event received:", url)
  event.preventDefault()
})

// Handle second instance (removed auth callback handling)
app.on("second-instance", (event, commandLine) => {
  console.log("second-instance event received:", commandLine)
  
  // Focus or create the main window
  if (!state.mainWindow) {
    createWindow()
  } else {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore()
    state.mainWindow.focus()
  }
})

// Prevent multiple instances of the app
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      // Save conversation history before quitting
      if (state.processingHelper) {
        try {
          state.processingHelper.saveConversationHistory();
        } catch (err) {
          console.error('Failed to save conversation history on exit:', err);
        }
      }
      
      app.quit()
      state.mainWindow = null
    }
  })
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// State getter/setter functions
function getMainWindow(): BrowserWindow | null {
  return state.mainWindow
}

function getView(): "queue" | "solutions" | "debug" {
  return state.view
}

function setView(view: "queue" | "solutions" | "debug"): void {
  state.view = view
  state.screenshotHelper?.setView(view)
}

function getScreenshotHelper(): ScreenshotHelper | null {
  return state.screenshotHelper
}

function getProblemInfo(): any {
  return state.problemInfo
}

function setProblemInfo(problemInfo: any): void {
  state.problemInfo = problemInfo
}

function getScreenshotQueue(): string[] {
  return state.screenshotHelper?.getScreenshotQueue() || []
}

function getExtraScreenshotQueue(): string[] {
  return state.screenshotHelper?.getExtraScreenshotQueue() || []
}

function clearQueues(): void {
  state.screenshotHelper?.clearQueues()
  state.problemInfo = null
  setView("queue")
}

async function takeScreenshot(): Promise<string> {
  if (!state.mainWindow) throw new Error("No main window available")
  return (
    state.screenshotHelper?.takeScreenshot(
      () => hideMainWindow(),
      () => showMainWindow()
    ) || ""
  )
}

async function getImagePreview(filepath: string): Promise<string> {
  return state.screenshotHelper?.getImagePreview(filepath) || ""
}

async function deleteScreenshot(
  path: string
): Promise<{ success: boolean; error?: string }> {
  return (
    state.screenshotHelper?.deleteScreenshot(path) || {
      success: false,
      error: "Screenshot helper not initialized"
    }
  )
}

function setHasDebugged(value: boolean): void {
  state.hasDebugged = value
}

function getHasDebugged(): boolean {
  return state.hasDebugged
}

/**
 * Handle speech transcriptions by sending to AI for processing
 */
async function handleSpeechTranscription(transcript: string): Promise<void> {
  console.log('Processing speech transcription:', transcript);
  
  try {
    // Enhanced validation for complete questions
    if (!transcript || transcript.trim().length < 5) {
      console.log('Skipping very short transcript:', transcript);
      return;
    }
    
    const trimmedTranscript = transcript.trim();
    
    // More robust duplicate detection with better timing
    const now = Date.now();
    const timeSinceLastProcessed = now - lastProcessedTime;
    const isDuplicate = (
      trimmedTranscript === lastProcessedText && 
      timeSinceLastProcessed < DEBOUNCE_TIME
    );
    
    if (isDuplicate) {
      console.log(`Skipping duplicate transcript (${timeSinceLastProcessed}ms ago):`, trimmedTranscript);
      return;
    }

    // Enhanced processing lock with timeout protection
    if (isCurrentlyProcessing) {
      // If we've been processing for too long (>30 seconds), reset the lock
      if (timeSinceLastProcessed > 30000) {
        console.log('Processing lock timeout detected, resetting...');
        isCurrentlyProcessing = false;
      } else {
        console.log('Already processing a transcript, queuing this one');
        processingQueue.push(trimmedTranscript);
        return;
      }
    }

    // Additional question quality checks
    if (!isValidInterviewQuestion(trimmedTranscript)) {
      console.log('Transcript does not appear to be a valid interview question:', trimmedTranscript);
      return;
    }

    // Set processing lock
    isCurrentlyProcessing = true;
    
    // Update last processed info
    lastProcessedText = trimmedTranscript;
    lastProcessedTime = now;

    console.log('Sending transcript to AI for processing...');
    
    // Use the ProcessingHelper to handle the AI request
    const processingHelper = getProcessingHelper();
    if (!processingHelper) {
      console.error('Processing helper not available');
      isCurrentlyProcessing = false;
      processNextInQueue();
      return;
    }
    
    // Process the transcript through AI with enhanced error handling
    const response = await processingHelper.processTranscriptionWithAI(trimmedTranscript);
    
    // Send the AI response to the renderer
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('ai-response', response);
      console.log('AI response sent to renderer');
    }
    
    // Release the processing lock
    isCurrentlyProcessing = false;
    
    // Process any queued transcripts
    processNextInQueue();
    
  } catch (error) {
    console.error('Error processing speech transcription:', error);
    
    // Always release the lock on error
    isCurrentlyProcessing = false;
    
    // Notify the renderer of the error
    const mainWindow = getMainWindow();
    if (mainWindow) {
      const errorMessage = error instanceof Error ? error.message : 'Error processing speech';
      mainWindow.webContents.send('ai-response-error', errorMessage);
    }
    
    // Process any queued transcripts
    processNextInQueue();
  }
}

/**
 * Enhanced question validation for interview context
 */
function isValidInterviewQuestion(text: string): boolean {
  if (!text || text.trim().length < 10) {
    return false;
  }
  
  const trimmedText = text.trim().toLowerCase();
  
  // Skip if it's clearly the candidate speaking (common self-references)
  const candidateIndicators = [
    'i think', 'i believe', 'i would', 'i will', 'i have', 'i am',
    'my approach', 'my solution', 'my experience', 'my understanding',
    'let me', 'so basically', 'essentially', 'fundamentally',
    'the answer is', 'the solution', 'this problem', 'this question'
  ];
  
  const hascandidateIndicators = candidateIndicators.some(indicator => 
    trimmedText.includes(indicator)
  );
  
  if (hascandidateIndicators) {
    console.log('Detected candidate speech patterns, skipping AI processing');
    return false;
  }
  
  // Check for interviewer patterns
  const interviewerPatterns = [
    // Direct questions
    'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whose', 'whom',
    // Requests and instructions
    'can you', 'could you', 'will you', 'would you', 'please',
    'tell me', 'explain', 'describe', 'elaborate', 'discuss', 'show me',
    'walk through', 'think about', 'consider', 'solve', 'implement',
    // Interview-specific
    'write a function', 'design a system', 'optimize this', 'improve',
    'time complexity', 'space complexity', 'algorithm', 'approach'
  ];
  
  const hasInterviewerPattern = interviewerPatterns.some(pattern =>
    trimmedText.includes(pattern)
  );
  
  // Must have interviewer patterns OR end with question mark
  return hasInterviewerPattern || trimmedText.endsWith('?');
}

/**
 * Process the next transcript in the queue
 */
function processNextInQueue(): void {
  if (processingQueue.length > 0 && !isCurrentlyProcessing) {
    const nextTranscript = processingQueue.shift();
    if (nextTranscript) {
      console.log('Processing queued transcript:', nextTranscript);
      // Small delay to avoid overwhelming the system
      setTimeout(() => {
        handleSpeechTranscription(nextTranscript);
      }, 100);
    }
  }
}

// Add this function with the other getter functions
function getProcessingHelper(): ProcessingHelper | null {
  return state.processingHelper;
}

// Export state and functions for other modules
export {
  state,
  createWindow,
  hideMainWindow,
  showMainWindow,
  toggleMainWindow,
  setWindowDimensions,
  moveWindowHorizontal,
  moveWindowVertical,
  getMainWindow,
  getView,
  setView,
  getScreenshotHelper,
  getProblemInfo,
  setProblemInfo,
  getScreenshotQueue,
  getExtraScreenshotQueue,
  clearQueues,
  takeScreenshot,
  getImagePreview,
  deleteScreenshot,
  setHasDebugged,
  getHasDebugged,
  getProcessingHelper
}

app.whenReady().then(initializeApp)
