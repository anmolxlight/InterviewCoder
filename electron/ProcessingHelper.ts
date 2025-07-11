// ProcessingHelper.ts
import fs from "node:fs"
import path from "node:path"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { IProcessingHelperDeps } from "./main"
import * as axios from "axios"
import { app, BrowserWindow, dialog } from "electron"
import { OpenAI } from "openai"
import { configHelper } from "./ConfigHelper"
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

// Interface for Gemini API requests
interface GeminiMessage {
  role: string;
  parts: Array<{
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string;
    }
  }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
}

export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private openaiClient: OpenAI | null = null
  private geminiApiKey: string | null = null

  // AbortControllers for API requests
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null
  
  // Add conversation history
  private conversationHistory: Array<{role: string, content: string}> = [];
  private readonly maxHistoryLength: number = 10; // Keep last 10 messages plus system prompt

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps
    this.screenshotHelper = deps.getScreenshotHelper()
    
    // Initialize AI client based on config
    this.initializeAIClient();
    
    // Listen for config changes to re-initialize the AI client
    configHelper.on('config-updated', () => {
      this.initializeAIClient();
    });
  }
  
  /**
   * Initialize or reinitialize the AI client with current config
   */
  private initializeAIClient(): void {
    try {
      const config = configHelper.loadConfig();
      
      if (config.apiProvider === "openai") {
        if (config.apiKey) {
          this.openaiClient = new OpenAI({ 
            apiKey: config.apiKey,
            timeout: 60000, // 60 second timeout
            maxRetries: 2   // Retry up to 2 times
          });
          this.geminiApiKey = null;
          console.log("OpenAI client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          console.warn("No API key available, OpenAI client not initialized");
        }
      } else {
        // Gemini client initialization
        this.openaiClient = null;
        if (config.apiKey) {
          this.geminiApiKey = config.apiKey;
          console.log("Gemini API key set successfully");
        } else {
          this.geminiApiKey = null;
          console.warn("No API key available, Gemini client not initialized");
        }
      }
    } catch (error) {
      console.error("Failed to initialize AI client:", error);
      this.openaiClient = null;
      this.geminiApiKey = null;
    }
  }

  private async waitForInitialization(
    mainWindow: BrowserWindow
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = 50 // 5 seconds total

    while (attempts < maxAttempts) {
      const isInitialized = await mainWindow.webContents.executeJavaScript(
        "window.__IS_INITIALIZED__"
      )
      if (isInitialized) return
      await new Promise((resolve) => setTimeout(resolve, 100))
      attempts++
    }
    throw new Error("App failed to initialize after 5 seconds")
  }

  private async getCredits(): Promise<number> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return 999 // Unlimited credits in this version

    try {
      await this.waitForInitialization(mainWindow)
      return 999 // Always return sufficient credits to work
    } catch (error) {
      console.error("Error getting credits:", error)
      return 999 // Unlimited credits as fallback
    }
  }

  private async getLanguage(): Promise<string> {
    try {
      // Get language from config
      const config = configHelper.loadConfig();
      if (config.language) {
        return config.language;
      }
      
      // Fallback to window variable if config doesn't have language
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        try {
          await this.waitForInitialization(mainWindow)
          const language = await mainWindow.webContents.executeJavaScript(
            "window.__LANGUAGE__"
          )

          if (
            typeof language === "string" &&
            language !== undefined &&
            language !== null
          ) {
            return language;
          }
        } catch (err) {
          console.warn("Could not get language from window", err);
        }
      }
      
      // Default fallback
      return "python";
    } catch (error) {
      console.error("Error getting language:", error)
      return "python"
    }
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    const config = configHelper.loadConfig();
    
    // First verify we have a valid AI client
    if (config.apiProvider === "openai" && !this.openaiClient) {
      this.initializeAIClient();
      
      if (!this.openaiClient) {
        console.error("OpenAI client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "gemini" && !this.geminiApiKey) {
      this.initializeAIClient();
      
      if (!this.geminiApiKey) {
        console.error("Gemini API key not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    }

    const view = this.deps.getView()
    console.log("Processing screenshots in view:", view)

    if (view === "queue") {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)
      const screenshotQueue = this.screenshotHelper.getScreenshotQueue()
      console.log("Processing main queue screenshots:", screenshotQueue)
      
      // Check if the queue is empty
      if (!screenshotQueue || screenshotQueue.length === 0) {
        console.log("No screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        // Show dialog if no screenshots
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'No Screenshots Detected',
          message: 'No screenshots were found to process.',
          detail: 'Please take a screenshot first using Ctrl+H (or Cmd+H on Mac). Make sure your screenshot contains the coding problem you want to solve.',
          buttons: ['OK']
        });
        return;
      }

      // Check that files actually exist
      const existingScreenshots = screenshotQueue.filter(path => fs.existsSync(path));
      if (existingScreenshots.length === 0) {
        console.log("Screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        // Show error dialog
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Screenshot Files Missing',
          message: 'The screenshot files were not found on disk.',
          detail: 'Try taking a new screenshot with Ctrl+H (or Cmd+H on Mac).',
          buttons: ['OK']
        });
        return;
      }

      try {
        // Initialize AbortController
        this.currentProcessingAbortController = new AbortController()
        const { signal } = this.currentProcessingAbortController

        const screenshots = await Promise.all(
          existingScreenshots.map(async (path) => {
            try {
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )

        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data");
        }

        const result = await this.processScreenshotsHelper(validScreenshots, signal)

        if (!result.success) {
          console.log("Processing failed:", result.error)
          if (result.error?.includes("API Key") || result.error?.includes("OpenAI") || result.error?.includes("Gemini")) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.API_KEY_INVALID
            )
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
              result.error
            )
          }
          // Reset view back to queue on error
          console.log("Resetting view to queue due to error")
          this.deps.setView("queue")
          return
        }

        // Only set view to solutions if processing succeeded
        console.log("Setting view to solutions after successful processing")
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
          result.data
        )
        this.deps.setView("solutions")
      } catch (error: any) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          error
        )
        console.error("Processing error:", error)
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            "Processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            error.message || "Server error. Please try again."
          )
        }
        // Reset view back to queue on error
        console.log("Resetting view to queue due to error")
        this.deps.setView("queue")
      } finally {
        this.currentProcessingAbortController = null
      }
    } else {
      // view == 'solutions'
      const extraScreenshotQueue =
        this.screenshotHelper.getExtraScreenshotQueue()
      console.log("Processing extra queue screenshots:", extraScreenshotQueue)
      
      // Check if the extra queue is empty
      if (!extraScreenshotQueue || extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        // Show dialog if no screenshots
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'No Debug Screenshots',
          message: 'No screenshots were found for debugging.',
          detail: 'Please take screenshots of your code/errors with Ctrl+H before debugging.',
          buttons: ['OK']
        });
        return;
      }

      // Check that files actually exist
      const existingExtraScreenshots = extraScreenshotQueue.filter(path => fs.existsSync(path));
      if (existingExtraScreenshots.length === 0) {
        console.log("Extra screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Screenshot Files Missing',
          message: 'The debug screenshot files were not found.',
          detail: 'Try taking a new screenshot with Ctrl+H (or Cmd+H on Mac).',
          buttons: ['OK']
        });
        return;
      }
      
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_START)

      // Initialize AbortController
      this.currentExtraProcessingAbortController = new AbortController()
      const { signal } = this.currentExtraProcessingAbortController

      try {
        // Get all screenshots (both main and extra) for processing
        const allPaths = [
          ...this.screenshotHelper.getScreenshotQueue(),
          ...existingExtraScreenshots
        ];
        
        const screenshots = await Promise.all(
          allPaths.map(async (path) => {
            try {
              if (!fs.existsSync(path)) {
                console.warn(`Screenshot file does not exist: ${path}`);
                return null;
              }
              
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )
        
        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data for debugging");
        }
        
        console.log(
          "Combined screenshots for processing:",
          validScreenshots.map((s) => s.path)
        )

        const result = await this.processExtraScreenshotsHelper(
          validScreenshots,
          signal
        )

        if (result.success) {
          this.deps.setHasDebugged(true)
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_SUCCESS,
            result.data
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            result.error
          )
        }
      } catch (error: any) {
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            "Extra processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            error.message
          )
        }
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  private async processScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const config = configHelper.loadConfig();
      const language = await this.getLanguage();
      const mainWindow = this.deps.getMainWindow();
      
      // Step 1: Extract problem info using AI Vision API (OpenAI or Gemini)
      const imageDataList = screenshots.map(screenshot => screenshot.data);
      
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Analyzing problem from screenshots...",
          progress: 20
        });
      }

      let problemInfo;
      
      if (config.apiProvider === "openai") {
        // Verify OpenAI client
        if (!this.openaiClient) {
          this.initializeAIClient(); // Try to reinitialize
          
          if (!this.openaiClient) {
            return {
              success: false,
              error: "OpenAI API key not configured or invalid. Please check your settings."
            };
          }
        }

        // Use OpenAI for processing
        const messages: ChatCompletionMessageParam[] = [
          {
            role: "system" as const, 
            content: "You are a coding challenge interpreter. Analyze the screenshot of the coding problem and extract all relevant information. If the screenshot contains a coding problem, return the information in JSON format with these fields: problem_statement, constraints, example_input, example_output. If the screenshot contains an MCQ, integer question, or aptitude question, return in JSON format with these fields: problem_statement, question_type (one of: 'mcq', 'integer', 'aptitude'), options (for MCQs, array of option text). Just return the structured JSON without any other text."
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: `Extract the coding problem details from these screenshots. Return in JSON format. Preferred coding language we gonna use for this problem is ${language}.`
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        // Send to OpenAI Vision API
        const extractionResponse = await this.openaiClient.chat.completions.create({
          model: config.extractionModel || "gpt-4o",
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });

        // Parse the response
        try {
          const responseText = extractionResponse.choices[0].message.content;
          // Handle when OpenAI might wrap the JSON in markdown code blocks
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error) {
          console.error("Error parsing OpenAI response:", error);
          return {
            success: false,
            error: "Failed to parse problem information. Please try again or use clearer screenshots."
          };
        }
      } else {
        // Use Gemini API
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          // Create Gemini message structure
          const geminiMessages: GeminiMessage[] = [
            {
              role: "user",
              parts: [
                {
                  text: `You are a coding challenge interpreter. Analyze the screenshots of the coding problem and extract all relevant information. If the screenshot contains a coding problem, return the information in JSON format with these fields: problem_statement, constraints, example_input, example_output. If the screenshot contains an MCQ, integer question, or aptitude question, return in JSON format with these fields: problem_statement, question_type (one of: 'mcq', 'integer', 'aptitude'), options (for MCQs, array of option text). Just return the structured JSON without any other text. Preferred coding language we gonna use for this problem is ${language}.`
                },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          const responseText = responseData.candidates[0].content.parts[0].text;
          
          // Handle when Gemini might wrap the JSON in markdown code blocks
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error) {
          console.error("Error using Gemini API:", error);
          return {
            success: false,
            error: "Failed to process with Gemini API. Please check your API key or try again later."
          };
        }
      }
      
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Problem analyzed successfully. Preparing to generate solution...",
          progress: 40
        });
      }

      // Store problem info in AppState
      this.deps.setProblemInfo(problemInfo);

      // Send first success event
      if (mainWindow) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
          problemInfo
        );

        // Generate solutions after successful extraction
        const solutionsResult = await this.generateSolutionsHelper(signal);
        if (solutionsResult.success) {
          // Clear any existing extra screenshots before transitioning to solutions view
          this.screenshotHelper.clearExtraScreenshotQueue();
          
          // Final progress update
          mainWindow.webContents.send("processing-status", {
            message: "Solution generated successfully",
            progress: 100
          });
          
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            solutionsResult.data
          );
          return { success: true, data: solutionsResult.data };
        } else {
          throw new Error(
            solutionsResult.error || "Failed to generate solutions"
          );
        }
      }

      return { success: false, error: "Failed to process screenshots" };
    } catch (error: any) {
      // If the request was cancelled, don't retry
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      // Handle OpenAI API errors specifically
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      } else if (error?.response?.status === 500) {
        return {
          success: false,
          error: "OpenAI server error. Please try again later."
        };
      }

      console.error("API Error Details:", error);
      return { 
        success: false, 
        error: error.message || "Failed to process screenshots. Please try again." 
      };
    }
  }

  private async generateSolutionsHelper(signal: AbortSignal) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Creating optimal solution with detailed explanations...",
          progress: 60
        });
      }

      // Create prompt for solution generation
      let promptText = "";
      
      if (problemInfo.question_type === 'mcq') {
        // Handle MCQ type questions
        promptText = `
Solve the following multiple choice question:

QUESTION:
${problemInfo.problem_statement}

OPTIONS:
${problemInfo.options ? problemInfo.options.map((opt: string, idx: number) => `${idx+1}. ${opt}`).join('\n') : "Options not provided clearly. Analyze the problem statement to identify options."}

I need you to think through this step-by-step:
1. First, analyze what the question is asking
2. Examine each option methodically
3. Use logical reasoning to evaluate each option
4. Explain why incorrect options are wrong
5. Explain why the correct option is right
6. State your final answer only after detailed analysis

IMPORTANT: Do not immediately identify the correct answer. Walk through your reasoning process thoroughly.
`;
      } else if (problemInfo.question_type === 'integer' || problemInfo.question_type === 'aptitude') {
        // Handle integer/aptitude type questions
        promptText = `
Solve the following ${problemInfo.question_type === 'integer' ? 'numerical' : 'aptitude'} question:

PROBLEM:
${problemInfo.problem_statement}

I need your solution to include:
1. A clear breakdown of the problem
2. Step-by-step approach to solving it
3. All calculations and reasoning shown clearly
4. A final answer that directly addresses the question

IMPORTANT: Show all your work and explain your reasoning for each step. Think logically and methodically.
`;
      } else {
        // Default coding problem handling
        promptText = `
Generate a detailed solution for the following coding problem:

PROBLEM STATEMENT:
${problemInfo.problem_statement}

CONSTRAINTS:
${problemInfo.constraints || "No specific constraints provided."}

EXAMPLE INPUT:
${problemInfo.example_input || "No example input provided."}

EXAMPLE OUTPUT:
${problemInfo.example_output || "No example output provided."}

LANGUAGE: ${language}

I need the response in the following format:
1. Code: A clean, optimized implementation in ${language}
2. Your Thoughts: A list of key insights and reasoning behind your approach
3. Time complexity: O(X) with a detailed explanation (at least 2 sentences)
4. Space complexity: O(X) with a detailed explanation (at least 2 sentences)

For complexity explanations, please be thorough. For example: "Time complexity: O(n) because we iterate through the array only once. This is optimal as we need to examine each element at least once to find the solution." or "Space complexity: O(n) because in the worst case, we store all elements in the hashmap. The additional space scales linearly with the input size."

Your solution should be efficient, well-commented, and handle edge cases.
`;
      }

      let responseContent;
      
      if (config.apiProvider === "openai") {
        // OpenAI processing
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }
        
        // Send to OpenAI API
        const solutionResponse = await this.openaiClient.chat.completions.create({
          model: config.solutionModel || "gpt-4o",
          messages: [
            { role: "system", content: "You are an expert coding interview assistant. Provide clear, optimal solutions with detailed explanations. You can also solve MCQs, integer questions, and aptitude problems. For MCQs, analyze each option methodically with step-by-step reasoning (chain of thought), don't give away the answer immediately. For integer and aptitude questions, show your work step-by-step and arrive at the final answer with clear logical reasoning." },
            { role: "user", content: promptText }
          ],
          max_tokens: 4000,
          temperature: 0.2
        });

        responseContent = solutionResponse.choices[0].message.content;
      } else {
        // Gemini processing
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          // Create Gemini message structure
          const geminiMessages = [
            {
              role: "user",
              parts: [
                {
                  text: `You are an expert coding interview assistant. Provide a clear, optimal solution with detailed explanations for this problem. You can also solve MCQs, integer questions, and aptitude problems. For MCQs, analyze each option methodically with step-by-step reasoning (chain of thought), don't give away the answer immediately. For integer and aptitude questions, show your work step-by-step and arrive at the final answer with clear logical reasoning.\n\n${promptText}`
                }
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          responseContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for solution:", error);
          return {
            success: false,
            error: "Failed to generate solution with Gemini API. Please check your API key or try again later."
          };
        }
      }
      
      // Extract parts from the response
      const codeMatch = responseContent.match(/```(?:\w+)?\s*([\s\S]*?)```/);
      const code = codeMatch ? codeMatch[1].trim() : responseContent;
      
      // Extract thoughts, looking for bullet points or numbered lists
      const thoughtsRegex = /(?:Thoughts:|Key Insights:|Reasoning:|Approach:|Analysis:|Step-by-step:|Solution approach:)([\s\S]*?)(?:Time complexity:|Conclusion:|Final answer:|Therefore,|$)/i;
      const thoughtsMatch = responseContent.match(thoughtsRegex);
      let thoughts: string[] = [];
      
      if (thoughtsMatch && thoughtsMatch[1]) {
        // Extract bullet points or numbered items
        const bulletPoints = thoughtsMatch[1].match(/(?:^|\n)\s*(?:[-*•]|\d+\.)\s*(.*)/g);
        if (bulletPoints) {
          thoughts = bulletPoints.map(point => 
            point.replace(/^\s*(?:[-*•]|\d+\.)\s*/, '').trim()
          ).filter(Boolean);
        } else {
          // If no bullet points found, split by newlines and filter empty lines
          thoughts = thoughtsMatch[1].split('\n')
            .map(line => line.trim())
            .filter(Boolean);
        }
      }
      
      // Default values for different question types
      let timeComplexity = "O(n) - Linear time complexity because we only iterate through the array once. Each element is processed exactly one time, and the hashmap lookups are O(1) operations.";
      let spaceComplexity = "O(n) - Linear space complexity because we store elements in the hashmap. In the worst case, we might need to store all elements before finding the solution pair.";
      
      // For non-coding problems, use different complexity fields
      if (problemInfo.question_type === 'mcq' || problemInfo.question_type === 'integer' || problemInfo.question_type === 'aptitude') {
        // Look for conclusion/final answer
        const finalAnswerRegex = /(?:Final answer:|In conclusion:|Therefore,|Thus,|The answer is:|The correct option is:|The solution is:)(.*?)(?:$|\.)/i;
        const finalAnswerMatch = responseContent.match(finalAnswerRegex);
        
        if (finalAnswerMatch && finalAnswerMatch[1]) {
          timeComplexity = "Final Answer: " + finalAnswerMatch[1].trim();
        } else {
          // Try to extract from the last paragraph
          const paragraphs = responseContent.split(/\n\s*\n/);
          if (paragraphs.length > 0) {
            const lastPara = paragraphs[paragraphs.length - 1].trim();
            timeComplexity = "Conclusion: " + lastPara;
          } else {
            timeComplexity = "See analysis for conclusion";
          }
        }
        
        // Space complexity field used for explanation summary
        spaceComplexity = problemInfo.question_type === 'mcq' ? 
          "Multiple Choice Question - See reasoning for option analysis" : 
          (problemInfo.question_type === 'integer' ? 
            "Numerical Question - See step-by-step solution" : 
            "Aptitude Question - See detailed solution approach");
      } else {
        // For coding problems, extract complexity normally
        const timeComplexityPattern = /Time complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:Space complexity|$))/i;
        const spaceComplexityPattern = /Space complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:[A-Z]|$))/i;
        
        const timeMatch = responseContent.match(timeComplexityPattern);
        if (timeMatch && timeMatch[1]) {
          timeComplexity = timeMatch[1].trim();
          if (!timeComplexity.match(/O\([^)]+\)/i)) {
            timeComplexity = `O(n) - ${timeComplexity}`;
          } else if (!timeComplexity.includes('-') && !timeComplexity.includes('because')) {
            const notationMatch = timeComplexity.match(/O\([^)]+\)/i);
            if (notationMatch) {
              const notation = notationMatch[0];
              const rest = timeComplexity.replace(notation, '').trim();
              timeComplexity = `${notation} - ${rest}`;
            }
          }
        }
        
        const spaceMatch = responseContent.match(spaceComplexityPattern);
        if (spaceMatch && spaceMatch[1]) {
          spaceComplexity = spaceMatch[1].trim();
          if (!spaceComplexity.match(/O\([^)]+\)/i)) {
            spaceComplexity = `O(n) - ${spaceComplexity}`;
          } else if (!spaceComplexity.includes('-') && !spaceComplexity.includes('because')) {
            const notationMatch = spaceComplexity.match(/O\([^)]+\)/i);
            if (notationMatch) {
              const notation = notationMatch[0];
              const rest = spaceComplexity.replace(notation, '').trim();
              spaceComplexity = `${notation} - ${rest}`;
            }
          }
        }
      }

      const formattedResponse = {
        code: code,
        thoughts: thoughts.length > 0 ? thoughts : ["Solution approach based on efficiency and readability"],
        time_complexity: timeComplexity,
        space_complexity: spaceComplexity
      };

      return { success: true, data: formattedResponse };
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      }
      
      console.error("Solution generation error:", error);
      return { success: false, error: error.message || "Failed to generate solution" };
    }
  }

  private async processExtraScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Processing debug screenshots...",
          progress: 30
        });
      }

      // Prepare the images for the API call
      const imageDataList = screenshots.map(screenshot => screenshot.data);
      
      let debugContent;
      
      if (config.apiProvider === "openai") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }
        
        const messages = [
          {
            role: "system" as const, 
            content: `You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

Your response MUST follow this exact structure with these section headers (use ### for headers):
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification (e.g. \`\`\`java).`
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: `I'm solving this coding problem: "${problemInfo.problem_statement}" in ${language}. I need help with debugging or improving my solution. Here are screenshots of my code, the errors or test cases. Please provide a detailed analysis with:
1. What issues you found in my code
2. Specific improvements and corrections
3. Any optimizations that would make the solution better
4. A clear explanation of the changes needed` 
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: "Analyzing code and generating debug feedback...",
            progress: 60
          });
        }

        const debugResponse = await this.openaiClient.chat.completions.create({
          model: config.debuggingModel || "gpt-4o",
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });
        
        debugContent = debugResponse.choices[0].message.content;
      } else {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          const debugPrompt = `
You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

I'm solving this coding problem: "${problemInfo.problem_statement}" in ${language}. I need help with debugging or improving my solution.

YOUR RESPONSE MUST FOLLOW THIS EXACT STRUCTURE WITH THESE SECTION HEADERS:
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification (e.g. \`\`\`java).
`;

          const geminiMessages = [
            {
              role: "user",
              parts: [
                { text: debugPrompt },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Gemini...",
              progress: 60
            });
          }

          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.debuggingModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          debugContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for debugging:", error);
          return {
            success: false,
            error: "Failed to process debug request with Gemini API. Please check your API key or try again later."
          };
        }
      }
      
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Debug analysis complete",
          progress: 100
        });
      }

      let extractedCode = "// Debug mode - see analysis below";
      const codeMatch = debugContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        extractedCode = codeMatch[1].trim();
      }

      let formattedDebugContent = debugContent;
      
      if (!debugContent.includes('# ') && !debugContent.includes('## ')) {
        formattedDebugContent = debugContent
          .replace(/issues identified|problems found|bugs found/i, '## Issues Identified')
          .replace(/code improvements|improvements|suggested changes/i, '## Code Improvements')
          .replace(/optimizations|performance improvements/i, '## Optimizations')
          .replace(/explanation|detailed analysis/i, '## Explanation');
      }

      const bulletPoints = formattedDebugContent.match(/(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g);
      const thoughts = bulletPoints 
        ? bulletPoints.map(point => point.replace(/^[ ]*(?:[-*•]|\d+\.)[ ]+/, '').trim()).slice(0, 5)
        : ["Debug analysis based on your screenshots"];
      
      const response = {
        code: extractedCode,
        debug_analysis: formattedDebugContent,
        thoughts: thoughts,
        time_complexity: "N/A - Debug mode",
        space_complexity: "N/A - Debug mode"
      };

      return { success: true, data: response };
    } catch (error: any) {
      console.error("Debug processing error:", error);
      return { success: false, error: error.message || "Failed to process debug request" };
    }
  }

  public cancelOngoingRequests(): void {
    let wasCancelled = false

    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
      wasCancelled = true
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
      wasCancelled = true
    }

    this.deps.setHasDebugged(false)

    this.deps.setProblemInfo(null)

    const mainWindow = this.deps.getMainWindow()
    if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
    }
  }

  /**
   * Process a speech transcription with the selected AI model
   * @param transcript The speech transcription to process
   * @returns The AI response
   */
  public async processTranscriptionWithAI(transcript: string): Promise<string> {
    console.log('Processing transcription with AI:', transcript);
    
    if (transcript.trim() === '') {
      throw new Error('Empty transcript provided');
    }
    
    // Process the transcript
    // For diarized transcripts, we'll only get interviewer questions here
    // so we can process them directly
    
    // Load config to determine which AI provider to use
    const config = configHelper.loadConfig();
    
    // Create a new abort controller for this request
    const abortController = new AbortController();
    this.currentProcessingAbortController = abortController;
    
    try {
      let response: string = '';
      
      if (config.apiProvider === 'openai') {
        // Process with OpenAI
        response = await this.processTranscriptionWithOpenAI(transcript, abortController.signal);
      } else {
        // Process with Gemini
        response = await this.processTranscriptionWithGemini(transcript, abortController.signal);
      }
      
      // Clean up the abort controller
      this.currentProcessingAbortController = null;
      
      return response;
    } catch (error) {
      console.error('Error processing transcription with AI:', error);
      
      // Clean up the abort controller
      this.currentProcessingAbortController = null;
      
      throw error;
    }
  }

  /**
   * Process a speech transcription with OpenAI
   * @param transcript The speech transcription to process
   * @param signal AbortSignal for cancellation
   * @returns The OpenAI response
   */
  private async processTranscriptionWithOpenAI(transcript: string, signal: AbortSignal): Promise<string> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }
    
    try {
      // Determine which model to use for conversation
      const config = configHelper.loadConfig();
      const model = config.solutionModel || 'gpt-4o'; // Use solution model for conversations
      
      // Updated interview helper system prompt
      const systemPrompt = `You are an interview helper designed to assist me, a software engineering candidate, in preparing for technical and behavioral interviews. Your role is to provide concise, accurate, and relevant answers to interview questions asked by the interviewer ONLY.

1. **Technical Questions**: 
   - Provide solutions for coding problems (in languages like Python, Java, C++, or JavaScript unless specified otherwise).
   - Answer SQL queries with clear, optimized solutions.
   - Explain concepts or solve problems related to AI/ML (e.g., algorithms, model training, evaluation metrics), DevOps (e.g., CI/CD, containerization, cloud platforms), and MLOps (e.g., model deployment, monitoring, pipelines).
   - Include brief explanations for technical answers to ensure understanding, but keep code or solutions prominent and concise.
   - If asked for code, provide complete, executable snippets without unnecessary comments unless clarification is needed.

2. **Behavioral Questions**: 
   - For questions like "Why should we hire you?", "Tell me about your top 5 failures that helped you grow," or "What are your top 3 leadership qualities?", respond in the **first person** (e.g., "I am a strong candidate because...").
   - Craft answers that are authentic, concise (150-200 words or less), and professional, reflecting my voice as a motivated software engineer.
   - Highlight transferable skills (e.g., problem-solving, teamwork, adaptability) and tie them to software engineering or the role.
   - Avoid generic or overly rehearsed responses; make answers specific but adaptable so I can repeat them verbatim.

**CRITICAL RULES**:
- ONLY respond to questions from the interviewer - NEVER respond to or evaluate the candidate's own statements.
- If you receive a transcript that appears to be the candidate reading back an answer or speaking, DO NOT respond to it at all.
- NEVER say phrases like "That's correct" or "Good point" that evaluate the candidate's statements.
- Do not acknowledge or comment on the candidate's responses in any way.
- Keep all answers concise, clear, and directly relevant to the interviewer's question.
- For technical questions, prioritize accuracy and efficiency in solutions.
- For behavioral questions, start with a direct statement I can repeat (e.g., "I believe you should hire me because...") and focus on my strengths as a software engineer.
- If the question is ambiguous, make reasonable assumptions (e.g., assume Python for coding unless specified).
- Avoid overly technical jargon in behavioral responses unless relevant to the role.
- Structure behavioral answers to feel personal and relatable without unnecessary commentary.

IMPORTANT: Only respond to clear questions from the interviewer. If the transcript doesn't contain a clear question from the interviewer or appears to be the candidate speaking, do not generate a response.`;
      
      // Prepare the messages array with system prompt and conversation history
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
      ];
      
      // Add conversation history if available
      if (this.conversationHistory.length > 0) {
        // Convert history items to proper ChatCompletionMessageParam format
        const historyMessages = this.conversationHistory.map(msg => {
          return { 
            role: msg.role as 'user' | 'assistant' | 'system', 
            content: msg.content 
          } as ChatCompletionMessageParam;
        });
        messages.push(...historyMessages);
      }
      
      // Add the current user message
      messages.push({ role: 'user', content: transcript });
      
      // Make the API call
      const response = await this.openaiClient.chat.completions.create({
        model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000,
      }, { signal });
      
      // Extract the response content
      if (response.choices && response.choices.length > 0) {
        const assistantResponse = response.choices[0].message.content || 'No response generated';
        
        // Update conversation history
        this.conversationHistory.push(
          { role: 'user', content: transcript },
          { role: 'assistant', content: assistantResponse }
        );
        
        // Trim history if needed, but keep the most recent exchanges
        if (this.conversationHistory.length > this.maxHistoryLength * 2) { // *2 because each exchange is 2 messages
          // Keep most recent conversations but remove older ones (except earliest context if any)
          this.conversationHistory = [
            ...this.conversationHistory.slice(0, 2), // Keep first exchange if available
            ...this.conversationHistory.slice(-this.maxHistoryLength * 2 + 2) // And most recent ones
          ];
        }
        
        // Save conversation history after each interaction
        this.saveConversationHistory();
        
        return assistantResponse;
      } else {
        return 'No response generated';
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request was cancelled');
      }
      console.error('OpenAI API error:', error);
      throw error;
    }
  }

  /**
   * Process a speech transcription with Gemini
   * @param transcript The speech transcription to process
   * @param signal AbortSignal for cancellation
   * @returns The Gemini response
   */
  private async processTranscriptionWithGemini(transcript: string, signal: AbortSignal): Promise<string> {
    if (!this.geminiApiKey) {
      throw new Error('Gemini API key not configured');
    }
    
    try {
      // Determine which model to use
      const config = configHelper.loadConfig();
      const model = config.solutionModel || 'gemini-2.0-flash'; // Use solution model for conversations
      
      // Updated interview helper system instruction
      const systemInstruction = `You are an interview helper designed to assist me, a software engineering candidate, in preparing for technical and behavioral interviews. Your role is to provide concise, accurate, and relevant answers to interview questions asked by the interviewer ONLY.

1. **Technical Questions**: 
   - Provide solutions for coding problems (in languages like Python, Java, C++, or JavaScript unless specified otherwise).
   - Answer SQL queries with clear, optimized solutions.
   - Explain concepts or solve problems related to AI/ML (e.g., algorithms, model training, evaluation metrics), DevOps (e.g., CI/CD, containerization, cloud platforms), and MLOps (e.g., model deployment, monitoring, pipelines).
   - Include brief explanations for technical answers to ensure understanding, but keep code or solutions prominent and concise.
   - If asked for code, provide complete, executable snippets without unnecessary comments unless clarification is needed.

2. **Behavioral Questions**: 
   - For questions like "Why should we hire you?", "Tell me about your top 5 failures that helped you grow," or "What are your top 3 leadership qualities?", respond in the **first person** (e.g., "I am a strong candidate because...").
   - Craft answers that are authentic, concise (150-200 words or less), and professional, reflecting my voice as a motivated software engineer.
   - Highlight transferable skills (e.g., problem-solving, teamwork, adaptability) and tie them to software engineering or the role.
   - Avoid generic or overly rehearsed responses; make answers specific but adaptable so I can repeat them verbatim.

**CRITICAL RULES**:
- ONLY respond to questions from the interviewer - NEVER respond to or evaluate the candidate's own statements.
- If you receive a transcript that appears to be the candidate reading back an answer or speaking, DO NOT respond to it at all.
- NEVER say phrases like "That's correct" or "Good point" that evaluate the candidate's statements.
- Do not acknowledge or comment on the candidate's responses in any way.
- Keep all answers concise, clear, and directly relevant to the interviewer's question.
- For technical questions, prioritize accuracy and efficiency in solutions.
- For behavioral questions, start with a direct statement I can repeat (e.g., "I believe you should hire me because...") and focus on my strengths as a software engineer.
- If the question is ambiguous, make reasonable assumptions (e.g., assume Python for coding unless specified).
- Avoid overly technical jargon in behavioral responses unless relevant to the role.
- Structure behavioral answers to feel personal and relatable without unnecessary commentary.

IMPORTANT: Only respond to clear questions from the interviewer. If the transcript doesn't contain a clear question from the interviewer or appears to be the candidate speaking, do not generate a response.`;
      
      // Prepare conversation history for Gemini
      let promptWithHistory = systemInstruction + "\n\n";
      
      // Add conversation history if available
      if (this.conversationHistory.length > 0) {
        promptWithHistory += "Our conversation so far:\n\n";
        
        this.conversationHistory.forEach(message => {
          const role = message.role === 'user' ? 'Interviewer' : 'Candidate';
          promptWithHistory += `${role}: ${message.content}\n\n`;
        });
      }
      
      // Add the current query and tell Gemini to analyze if this is a question or the candidate reading a response
      promptWithHistory += `Here is the new transcript: "${transcript}"\n\nBefore responding, analyze if this transcript contains a clear interviewer question. Only respond if it's a genuine question. If it seems like the candidate reading back an answer or stating information without a question, DO NOT respond to it.`;
      
      // Create a message including system-like instruction with history
      const messages: GeminiMessage[] = [
        {
          role: 'user',
          parts: [
            {
              text: promptWithHistory,
            },
          ],
        },
      ];
      
      // Make the API request
      const response = await axios.default.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiApiKey}`,
        {
          contents: messages,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1000,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          signal,
        }
      );
      
      // Parse and return the response
      const geminiResponse = response.data as GeminiResponse;
      if (
        geminiResponse.candidates &&
        geminiResponse.candidates.length > 0 &&
        geminiResponse.candidates[0].content &&
        geminiResponse.candidates[0].content.parts &&
        geminiResponse.candidates[0].content.parts.length > 0
      ) {
        const assistantResponse = geminiResponse.candidates[0].content.parts[0].text || 'No response generated';
        
        // Update conversation history
        this.conversationHistory.push(
          { role: 'user', content: transcript },
          { role: 'assistant', content: assistantResponse }
        );
        
        // Trim history if needed
        if (this.conversationHistory.length > this.maxHistoryLength * 2) {
          this.conversationHistory = [
            ...this.conversationHistory.slice(0, 2), // Keep first exchange if available
            ...this.conversationHistory.slice(-this.maxHistoryLength * 2 + 2) // And most recent ones
          ];
        }
        
        // Save conversation history after each interaction
        this.saveConversationHistory();
        
        return assistantResponse;
      } else {
        return 'No response generated';
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request was cancelled');
      }
      console.error('Gemini API error:', error);
      throw error;
    }
  }

  /**
   * Clear the conversation history
   */
  public clearConversationHistory(): void {
    this.conversationHistory = [];
    console.log('Conversation history cleared');
  }
  
  /**
   * Get the current conversation history
   */
  public getConversationHistory(): Array<{role: string, content: string}> {
    return [...this.conversationHistory];
  }
  
  /**
   * Save conversation history to a file for persistence
   */
  public saveConversationHistory(): void {
    try {
      const userDataPath = app.getPath('userData');
      const historyFilePath = path.join(userDataPath, 'conversation_history.json');
      
      // Create a safe copy of the history to save
      const historyCopy = JSON.stringify(this.conversationHistory, null, 2);
      
      // Write to file
      fs.writeFileSync(historyFilePath, historyCopy, 'utf8');
      console.log('Conversation history saved to file');
    } catch (error) {
      console.error('Failed to save conversation history to file:', error);
    }
  }
  
  /**
   * Load conversation history from file
   */
  public async loadConversationHistory(): Promise<void> {
    try {
      const userDataPath = app.getPath('userData');
      const historyFilePath = path.join(userDataPath, 'conversation_history.json');
      
      // Check if file exists
      if (fs.existsSync(historyFilePath)) {
        const historyData = fs.readFileSync(historyFilePath, 'utf8');
        this.conversationHistory = JSON.parse(historyData);
        console.log('Loaded conversation history:', this.conversationHistory.length, 'messages');
      }
    } catch (error) {
      console.error('Failed to load conversation history from file:', error);
      // If load fails, start with empty history to be safe
      this.conversationHistory = [];
    }
  }
}