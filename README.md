# InterviewCoder

InterviewCoder is an AI-powered interview preparation assistant designed specifically for software engineers. It combines speech recognition, screenshot analysis, and state-of-the-art language models to provide an interactive coding interview simulation experience.

![InterviewCoder](assets/icons/win/interviewcoderico.ico)

## Key Features

- **Voice-Driven Interview Simulation**: Have realistic interview conversations using Deepgram's Nova-3 speech recognition  
- **Contextual Memory**: Maintains conversation history for natural, hour-long interview flows with persistent context  
- **Multi-speaker Diarization**: Automatically identifies and distinguishes between interviewer and candidate voices  
- **Meeting Transcription**: Optimized for conference room settings with multiple speakers  
- **Multilingual Support**: Handles code-switching and multiple languages in real-time  
- **Screenshot Analysis**: Capture and analyze coding problems from your screen  
- **AI-Powered Solution Generation**: Get optimal coding solutions with detailed explanations  
- **First-Person Behavioral Responses**: Receive authentic, well-crafted responses to behavioral questions.
- **Code Debugging Assistance**: Get help fixing errors in your code with detailed explanations  

## Installation

### Prerequisites

- Node.js (16+)
- npm or bun package manager
- OpenAI API key or Google Gemini API key
- Deepgram API key (for speech recognition)

### Steps

1. Clone the repository

```bash
   git clone https://github.com/yourusername/InterviewCoder.git
   cd InterviewCoder
```

2. Install dependencies

```bash
npm install
```

3. Start the application

```bash
   .\stealth-run.bat
   ```

## Usage

### Initial Setup

1. Launch the application  
2. Click on "Settings" to configure your API keys:
   - Add your OpenAI/Gemini API key for the coding solution generation  
   - Add your Deepgram API key for speech recognition  
   - Select your preferred programming language  

### Interview Practice

1. Click the "Mic" button to start speech recognition  
2. Begin your interview practice session:
   - For technical questions: The AI will analyze your question and provide a coding solution  
   - For behavioral questions: The AI will respond in first person as if it were you  
3. Context is automatically maintained throughout your session  
4. Use the "Clear History" button when you want to start a new interview session  

### Screenshot Analysis

1. Use `Ctrl+H` (or `Cmd+H` on Mac) to capture screenshots of coding problems  
2. Click "Process" to analyze the problem and generate solutions  
3. Review the AI-generated solution with explanations, time complexity, and space complexity analysis  

### Debugging Help

1. Take screenshots of your code and error messages using `Ctrl+H`  
2. Click "Debug" to get detailed feedback and improvement suggestions  

## Keyboard Shortcuts

- **Ctrl+H / Cmd+H**: Take a screenshot  
- **Ctrl+R / Cmd+R**: Reset the application  
- **Ctrl+Left/Right/Up/Down**: Move the application window  
- **Ctrl+P / Cmd+P**: Process screenshots  
- **Esc**: Toggle the application window  

## Configuration Options

### AI Providers

InterviewCoder supports multiple AI providers:

- **OpenAI**: Supports GPT-4o and other models  
- **Google Gemini**: Supports Gemini Pro and other models  

### Speech Recognition

- **Model**: Nova-3 for superior transcript quality  
- **Diarization**: Distinguishes between different speakers in meeting settings  
- **Language**: Supports multiple languages and code-switching with `language=multi` setting  
- **Persistent Context**: Conversation history is maintained for natural interview flow and saved between sessions  

## Technical Details

InterviewCoder is built using:

- **Electron**: For cross-platform desktop application  
- **TypeScript**: For type-safe code  
- **React**: For the user interface  
- **Tailwind CSS**: For styling  
- **Deepgram API**: For speech recognition with Nova-3 model  
- **OpenAI/Gemini API**: For AI-powered features  
- **File-based Storage**: For persistent conversation history  

## Requirements

- **Operating System**: Windows 10+, macOS 10.13+, or Linux  
- **Storage**: 200MB minimum  
- **Memory**: 4GB RAM minimum (8GB recommended)  
- **Internet**: Required for API access  

## Recent Updates

- **Enhanced Conversation Context**: Added persistent conversation memory that saves between sessions  
- **Optimized Deepgram Integration**: Upgraded to Nova-3 with multi-language support and improved diarization  
- **Meeting Transcription Support**: Enhanced diarization for multiple speakers in conference room settings  
- **File-based Storage**: Added reliable persistent storage for conversation history  

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository  
2. Create your feature branch (`git checkout -b feature/amazing-feature`)  
3. Commit your changes (`git commit -m 'Add some amazing feature'`)  
4. Push to the branch (`git push origin feature/amazing-feature`)  
5. Open a Pull Request
