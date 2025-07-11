// file: src/components/SubscribedApp.tsx
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import Queue from "../_pages/Queue"
import Solutions from "../_pages/Solutions"
import { useToast } from "../contexts/toast"
import { SpeechToText, SpeechSettings } from '../components/SpeechToText';

interface SubscribedAppProps {
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
}

const SubscribedApp: React.FC<SubscribedAppProps> = ({
  credits,
  currentLanguage,
  setLanguage
}) => {
  const queryClient = useQueryClient()
  const [view, setView] = useState<"queue" | "solutions" | "debug">("queue")
  const containerRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()
  const [isSpeechSettingsOpen, setIsSpeechSettingsOpen] = useState(false);

  // Let's ensure we reset queries etc. if some electron signals happen
  useEffect(() => {
    const cleanup = window.electronAPI.onResetView(() => {
      queryClient.invalidateQueries({
        queryKey: ["screenshots"]
      })
      queryClient.invalidateQueries({
        queryKey: ["problem_statement"]
      })
      queryClient.invalidateQueries({
        queryKey: ["solution"]
      })
      queryClient.invalidateQueries({
        queryKey: ["new_solution"]
      })
      setView("queue")
    })

    return () => {
      cleanup()
    }
  }, [])

  // Dynamically update the window size
  useEffect(() => {
    if (!containerRef.current) return

    const updateDimensions = () => {
      if (!containerRef.current) return
      
      // Get the actual content height including all dynamic content
      const height = containerRef.current.scrollHeight || 600
      const width = containerRef.current.scrollWidth || 800
      
      // Add extra padding to ensure no scrolling is needed
      const paddedHeight = height + 50
      
      window.electronAPI?.updateContentDimensions({ 
        width, 
        height: paddedHeight
      })
      
      // Force the container to expand to full content height
      containerRef.current.style.minHeight = `${height}px`
    }

    // Force initial dimension update immediately
    updateDimensions()
    
    // Set a fallback timer to ensure dimensions are set even if content isn't fully loaded
    const fallbackTimer = setTimeout(() => {
      window.electronAPI?.updateContentDimensions({ width: 800, height: 600 })
    }, 500)

    const resizeObserver = new ResizeObserver(() => {
      // Use setTimeout to allow all DOM updates to complete
      setTimeout(updateDimensions, 50)
    })
    
    resizeObserver.observe(containerRef.current)

    // Also watch DOM changes with more specific options
    const mutationObserver = new MutationObserver(() => {
      // Use setTimeout to allow all DOM updates to complete
      setTimeout(updateDimensions, 50)
    })
    
    mutationObserver.observe(containerRef.current, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    })

    // Do additional updates after delays to catch any late-loading content
    const delayedUpdates = [
      setTimeout(updateDimensions, 300),
      setTimeout(updateDimensions, 1000),
      setTimeout(updateDimensions, 2000)
    ]

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      clearTimeout(fallbackTimer)
      delayedUpdates.forEach(timeout => clearTimeout(timeout))
    }
  }, [view])

  // Listen for events that might switch views or show errors
  useEffect(() => {
    const cleanupFunctions = [
      window.electronAPI.onSolutionStart(() => {
        setView("solutions")
      }),
      window.electronAPI.onUnauthorized(() => {
        queryClient.removeQueries({
          queryKey: ["screenshots"]
        })
        queryClient.removeQueries({
          queryKey: ["solution"]
        })
        queryClient.removeQueries({
          queryKey: ["problem_statement"]
        })
        setView("queue")
      }),
      window.electronAPI.onResetView(() => {
        queryClient.removeQueries({
          queryKey: ["screenshots"]
        })
        queryClient.removeQueries({
          queryKey: ["solution"]
        })
        queryClient.removeQueries({
          queryKey: ["problem_statement"]
        })
        setView("queue")
      }),
      window.electronAPI.onResetView(() => {
        queryClient.setQueryData(["problem_statement"], null)
      }),
      window.electronAPI.onProblemExtracted((data: any) => {
        if (view === "queue") {
          queryClient.invalidateQueries({
            queryKey: ["problem_statement"]
          })
          queryClient.setQueryData(["problem_statement"], data)
        }
      }),
      window.electronAPI.onSolutionError((error: string) => {
        showToast("Error", error, "error")
      })
    ]
    return () => cleanupFunctions.forEach((fn) => fn())
  }, [view])

  return (
    <div ref={containerRef} className="min-h-0">
      {view === "queue" ? (
        <Queue
          setView={setView}
          credits={credits}
          currentLanguage={currentLanguage}
          setLanguage={setLanguage}
        />
      ) : view === "solutions" ? (
        <Solutions
          setView={setView}
          credits={credits}
          currentLanguage={currentLanguage}
          setLanguage={setLanguage}
        />
      ) : null}
      <div className="mt-6">
        <SpeechToText onSettingsOpen={() => setIsSpeechSettingsOpen(true)} />
        <SpeechSettings 
          open={isSpeechSettingsOpen}
          onOpenChange={setIsSpeechSettingsOpen}
        />
      </div>
    </div>
  )
}

export default SubscribedApp
