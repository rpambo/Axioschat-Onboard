import { useState, useEffect } from "react"

interface ApiKeys {
  openai: string
  replicate: string
  aimlapi: string
  sensay: string
}

export default function useApiKeys() {
  const [apiKeys, setApiKeys] = useState<ApiKeys>({
    openai: "",
    replicate: "",
    aimlapi: "",
    sensay: ""
  })
  const [isLoaded, setIsLoaded] = useState(false)

  // Load API keys from localStorage
  useEffect(() => {
    try {
      const storedKeys = localStorage.getItem("apiKeys")
      if (storedKeys) {
        const parsedKeys = JSON.parse(storedKeys)
        setApiKeys({
          openai: parsedKeys.openai || "",
          replicate: parsedKeys.replicate || "",
          aimlapi: parsedKeys.aimlapi || parsedKeys.gemini || "", // Support migration from gemini
          sensay: parsedKeys.sensay || ""
        })
      }
      setIsLoaded(true)
    } catch (error) {
      console.error("Error loading API keys:", error)
      setIsLoaded(true)
    }
  }, [])

  // Function to update a specific API key
  const updateApiKey = (key: keyof ApiKeys, value: string) => {
    setApiKeys((prevKeys) => {
      const updatedKeys = { ...prevKeys, [key]: value }
      try {
        localStorage.setItem("apiKeys", JSON.stringify(updatedKeys))
      } catch (error) {
        console.error("Error saving API key:", error)
      }
      return updatedKeys
    })
  }

  return { apiKeys, updateApiKey, isLoaded }
} 