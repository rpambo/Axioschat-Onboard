import { toast } from "@/components/ui/use-toast"

export interface AIMLFunctionRequest {
  query: string
  tools: string
  top_p?: number
  temperature?: number
  max_output_tokens?: number
}

// Get AIML API token from localStorage
const getAIMLApiToken = (): string => {
  let token = ""
  try {
    const apiKeys = localStorage.getItem("apiKeys")
    if (apiKeys) {
      const parsed = JSON.parse(apiKeys)
      if (parsed.aimlapi) token = parsed.aimlapi
    }
  } catch (error) {
    console.error("Error retrieving AIML API token from localStorage:", error)
  }
  // Fallback to environment variables if not found in localStorage (for dev convenience)
  if (!token) {
    token = import.meta.env.VITE_AIMLAPI_KEY || import.meta.env.NEXT_PUBLIC_AIMLAPI_KEY || ""
    if (token) console.log("Using AIML API key from environment variable")
  }
  return token
}

// Call AIML model for function calling with retry mechanism for stability
export const callAIMLForFunctions = async (
  input: AIMLFunctionRequest,
): Promise<string | { text?: string; error?: string; functionCalls?: any[] }> => {
  try {
    const AIMLAPI_KEY = getAIMLApiToken()
    // Note: proceed even if no AIMLAPI_KEY to allow backend to handle defaults

    console.log("Calling AIML API with input:", {
      query: input.query.substring(0, 50) + "...",
      temperature: input.temperature,
      top_p: input.top_p,
    })

    // Format the request body for AIML's API 
    const requestBody = {
      query: input.query,
      tools: input.tools, // Same tools JSON string format
      top_p: input.top_p || 0.9,
      temperature: input.temperature || 0.7,
      max_output_tokens: input.max_output_tokens || 3000,
      model: "gpt-4o" // Default model for function calling
    }

    console.log("Request body:", JSON.stringify(requestBody, null, 2))

    // Implement retry mechanism for stability
    const maxRetries = 2
    let retryCount = 0
    let responseData

    // Call a relative path; Vercel will rewrite this to the deployed Render backend
    const apiUrl = "/api/aiml_functions"

    // Retry loop for stability
    while (retryCount <= maxRetries) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 30000)

        const headers: HeadersInit = {
          "Content-Type": "application/json",
        }
        if (AIMLAPI_KEY) {
          headers["X-AIMLAPI-Key"] = AIMLAPI_KEY
        }

        const response = await fetch(apiUrl, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        if (!response.ok) {
          let errorMessage = `AIML API Error (${response.status}): `
          try {
            const data = await response.json()
            errorMessage += data.error || JSON.stringify(data)
          } catch {}
          throw new Error(errorMessage)
        }
        responseData = await response.json()
        break
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return { error: "Request timed out. Please try again." }
        }
        retryCount++
        if (retryCount <= maxRetries) {
          await new Promise((res) => setTimeout(res, 1000 * 2 ** retryCount))
          continue
        }
        throw error
      }
    }

    if (!responseData) {
      return { error: "No response from AIML endpoint" }
    }
    
    if (responseData.error) {
      console.error("Error from AIML API:", responseData.error)
      return { error: responseData.error }
    }
    
    if (responseData.status === "partial_failure") {
      // Handle partial failures with a text response
      return { text: responseData.output || "I couldn't process your request properly. Please try rephrasing your question." }
    }

    // Handle the output from the AIML API
    if (responseData.output) {
      console.log("Complete output from AIML:", responseData.output)

      // If the output is a plain text response, return it
      if (typeof responseData.output === "string") {
        return responseData.output
      }

      // If the output is an array of function calls
      if (Array.isArray(responseData.output)) {
        console.log("Function calls found:", responseData.output.length)
        return { 
          functionCalls: responseData.output,
          text: responseData.text_if_any || "I need to perform some actions to answer your question."
        }
      }

      // If we can't determine the format, return the raw output as text
      return { text: typeof responseData.output === 'object' ? 
        JSON.stringify(responseData.output) : 
        String(responseData.output) 
      }
    } else if (responseData.text_if_any) {
      // If there's a text response but no function calls
      return { text: responseData.text_if_any }
    }

    return {
      text: "The model did not return a valid response. This may indicate an issue with the API or the model configuration.",
    }
  } catch (error) {
    console.error("Error calling AIML Functions model via proxy:", error)

    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred while calling the AI model"

    toast({
      title: "API Error",
      description: errorMessage,
      variant: "destructive",
    })

    return { error: `Error: ${errorMessage}` }
  }
}

// Backward compatibility: export with old name
export const callGeminiForFunctions = callAIMLForFunctions;

// We can reuse the same tools JSON definition from replicateProxyService.ts
// This is exported from there and imported where needed 