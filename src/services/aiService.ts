import { toast } from "@/components/ui/use-toast"
import { v4 as uuidv4 } from "uuid"
import OpenAI from "openai"
import { callGeminiForFunctions } from "./geminiService"
import { callSensay, callSensayWithContext } from "./sensayService"

export type ChatMessage = {
  role: "user" | "assistant" | "system" | "function"
  content: string
  name?: string
}

export type FunctionCall = {
  id: string
  name: string
  arguments: Record<string, any>
  status?: "pending" | "approved" | "rejected" | "executed"
  result?: any
}

export type LlamaOptions = {
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string[]
}

export type OpenAIOptions = {
  model: string  // Now refers to AIML API model
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string[]
}

export interface LlamaRequest {
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
}

export interface OpenAIRequest {
  messages: ChatMessage[]
  model: string  // Now refers to AIML API model
  temperature?: number
  top_p?: number
  max_tokens?: number
}

export interface FlockWeb3Request {
  query: string
  tools: string
  top_p?: number
  temperature?: number
  max_new_tokens?: number
  messages?: ChatMessage[]
}

// Get API tokens from localStorage
const getApiTokens = (): { aimlapi: string; openai: string; replicate: string; sensay: string } => {
  try {
    const apiKeys = localStorage.getItem("apiKeys")
    if (apiKeys) {
      const parsed = JSON.parse(apiKeys)
      return {
        aimlapi: parsed.aimlapi || parsed.openai || "", // Check for both aimlapi and openai keys
        openai: parsed.openai || "",
        replicate: parsed.replicate || "",
        sensay: parsed.sensay || "", // Add Sensay API key
      }
    }
  } catch (error) {
    console.error("Error retrieving API tokens:", error)
  }
  return { aimlapi: "", openai: "", replicate: "", sensay: "" }
}

// Call Llama model (now using AIML API in production)
export async function callLlama(options: LlamaOptions, endpoint: string, useSensay: boolean = false): Promise<string> {
  try {
    // Check if we're in production (Vercel) or development
    const isProduction = !endpoint.includes("localhost") && !endpoint.includes("127.0.0.1")

    // If Sensay is selected, use it regardless of environment
    if (useSensay) {
      const { sensay: SENSAY_API_KEY } = getApiTokens()

      if (!SENSAY_API_KEY) {
        return "Please provide a Sensay API key in the settings to use the chatbot."
      }

      // Use Sensay for completions
      return await callSensayWithContext(options.messages)
    } else if (isProduction) {
      // In production, use AIML API via the OpenAI compatibility layer
      const { aimlapi: AIMLAPI_KEY } = getApiTokens()

      if (!AIMLAPI_KEY) {
        return "Please provide an AIML API key in the settings to use the chatbot."
      }

      // Call OpenAI function which now uses AIML API
      return await callOpenAI({
        model: "gpt-4o",
        messages: options.messages,
        temperature: options.temperature,
        top_p: options.top_p,
        max_tokens: options.max_tokens,
        stop: options.stop,
      })
    } else {
      // In development, use the local Llama server
      const response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama3.2:latest",
          messages: options.messages,
          temperature: options.temperature || 0.7,
          top_p: options.top_p || 0.9,
          max_tokens: options.max_tokens || 2000,
          stop: options.stop || [],
          stream: false,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Failed to call Llama model: ${errorText}`)
      }

      const data = await response.json()
      if (data.message && data.message.content) {
        return data.message.content
      } else {
        return "No valid response from Llama model"
      }
    }
  } catch (error) {
    console.error("Error calling Llama:", error)
    return `Error: ${error instanceof Error ? error.message : "Unknown error"}`
  }
}

// Call OpenAI model (now using AIML API via server proxy)
export async function callOpenAI(options: OpenAIOptions, useSensay: boolean = false): Promise<string> {
  // If Sensay is selected as the model, use it
  if (useSensay) {
    const { sensay: SENSAY_API_KEY } = getApiTokens();
    
    if (!SENSAY_API_KEY) {
      return "Please provide a Sensay API key in the settings to use the chatbot.";
    }
    
    return await callSensayWithContext(options.messages);
  }
  
  try {
    const { aimlapi: AIMLAPI_KEY } = getApiTokens();
    // If no key in localStorage, allow proxies to supply from server env

    // Convert our message format to OpenAI SDK format
    const formattedMessages = options.messages.map(msg => {
      if (msg.role === "function") {
        return {
          role: msg.role,
          name: msg.name || "function", // Function messages must have a name
          content: msg.content
        } as any;
      }
      return {
        role: msg.role,
        content: msg.content
      } as any;
    });

    // Create request body
    const requestBody = {
      model: "gpt-4o",
      messages: formattedMessages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2000,
    };

    console.log("Calling AIML API via proxy with key:", AIMLAPI_KEY ? "API key exists" : "No API key");

    // Use both proxy endpoints with fallback
    try {
      // First try with proxy-gemini endpoint (now using AIML)
      const response = await fetch("/api/proxy-gemini", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(AIMLAPI_KEY ? { "X-AIMLAPI-Key": AIMLAPI_KEY } : {}),
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to call proxy-aiml: ${errorText}`);
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message) {
        return data.choices[0].message.content || "";
      } else {
        throw new Error("Invalid response format from proxy-aiml");
      }
    } catch (proxyError) {
      console.warn("proxy-aiml failed, trying alternative endpoint:", proxyError);
      
      // Try with alternative gemini-proxy endpoint (now using AIML)
      const altResponse = await fetch("/api/gemini-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(AIMLAPI_KEY ? { "X-AIMLAPI-Key": AIMLAPI_KEY } : {}),
        },
        body: JSON.stringify(requestBody)
      });

      if (!altResponse.ok) {
        const errorText = await altResponse.text();
        throw new Error(`Failed to call alternative aiml-proxy: ${errorText}`);
      }

      const altData = await altResponse.json();
      if (altData.choices && altData.choices.length > 0 && altData.choices[0].message) {
        return altData.choices[0].message.content || "";
      } else {
        throw new Error("Invalid response format from alternative aiml-proxy");
      }
    }
  } catch (error) {
    console.error("Error calling AIML API:", error);
    return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

// Call FlockWeb3 model - now updated to use AIML API for function calling
export const callFlockWeb3 = async (
  input: FlockWeb3Request,
): Promise<{ text?: string; error?: string; functionCalls?: FunctionCall[] } | string> => {
  try {
    // API key check is removed here; backend (Render) is responsible for using its env var.

    console.log("Calling AIML Functions API (via callFlockWeb3) with input:", {
      query: input.query.substring(0, 50) + "...",
      temperature: input.temperature,
      top_p: input.top_p,
    })

    // Call the AIML function calling service with the same input structure
    // Note: Using gpt-4o model as specified
    const aimlResponse = await callGeminiForFunctions({
      query: input.query,
      tools: input.tools,
      top_p: input.top_p,
      temperature: input.temperature,
      max_output_tokens: input.max_new_tokens,
    })

    // Process the output from AIML API
    if (typeof aimlResponse === 'string') {
      return { text: aimlResponse }
    }

    // If there's an error, return it with proper formatting
    if (aimlResponse.error) {
      console.error("Error from AIML function calling:", aimlResponse.error)
      // Return a user-friendly error message but don't break the conversation
      return { 
        text: `I encountered an issue processing your request: ${aimlResponse.error.substring(0, 100)}... Let me try a different approach.`,
        error: aimlResponse.error
      }
    }

    // If there are function calls, process them
    if (aimlResponse.functionCalls && Array.isArray(aimlResponse.functionCalls)) {
      console.log("Parsed function calls from AIML API:", aimlResponse.functionCalls)

      // Format the function calls to match the expected structure
      const formattedFunctionCalls: FunctionCall[] = aimlResponse.functionCalls.map((call, index) => {
        // Ensure we have valid arguments even if they're not provided
        const args = call.arguments || {}
        
        return {
          id: `func-${Date.now()}-${index}`,
          name: call.name,
          description: call.description || `Execute ${call.name} function`,
          arguments: args,
          status: "pending" as const,
        }
      }).filter(call => call.name && typeof call.name === 'string') // Ensure only valid calls get through

      // Also include any text response that came with the function calls
      const textResponse = aimlResponse.text || 
        "I'll help you with that by performing some actions."

      if (formattedFunctionCalls.length > 0) {
        return { 
          functionCalls: formattedFunctionCalls,
          text: textResponse
        }
      } else {
        // If no valid function calls were found, return a text response
        return { text: textResponse || "I couldn't find any valid function calls in the model's response." }
      }
    }

    // If there's text content, return it
    if (aimlResponse.text) {
      return { text: aimlResponse.text }
    }

    // Fallback response to ensure the conversation continues
    return { text: "I understand your request, but I'm not sure how to process it. Could you please rephrase?" }
  } catch (error) {
    console.error("Error calling AI model for function calling:", error)
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred while calling the AI model"
    
    // Only show toast for significant errors
    if (!(error instanceof Error && error.message.includes("AbortError"))) {
      toast({
        title: "AI API Error",
        description: errorMessage,
        variant: "destructive",
      })
    }
    
    // Return a more user-friendly error that doesn't break the conversation
    return { 
      text: "I'm having trouble connecting to my knowledge sources right now. Let me try a different approach to help you.",
      error: errorMessage 
    }
  }
}

// Parse Llama response for function calls
export function parseLlamaResponse(response: string): {
  text: string
  functionName?: string
  functionArgs?: Record<string, any>
} {
  // Check if the response contains a function call tag
  const functionCallRegex = /\[FUNCTION_CALL:([a-zA-Z_]+)\]/
  const match = response.match(functionCallRegex)

  if (!match) {
    return { text: response }
  }

  const functionName = match[1]
  const text = response.replace(functionCallRegex, "").trim()

  // Extract arguments based on the function name
  let functionArgs: Record<string, any> = {}

  // Extract wallet address if present in the text
  const walletAddressRegex = /0x[a-fA-F0-9]{40}/
  const walletAddressMatch = text.match(walletAddressRegex)
  if (walletAddressMatch) {
    functionArgs.wallet_address = walletAddressMatch[0]
  }

  // Extract token symbol if present
  const tokenSymbolRegex = /\b(BTC|ETH|BNB|USDT|USDC|DAI|LINK|UNI|AAVE|CAKE|MATIC|SOL|DOT|ADA|XRP|DOGE|SHIB)\b/i
  const tokenSymbolMatch = text.match(tokenSymbolRegex)
  if (tokenSymbolMatch) {
    functionArgs.token_symbol = tokenSymbolMatch[0].toUpperCase()
  }

  // Extract amount if present
  const amountRegex =
    /\b(\d+(\.\d+)?)\s*(BTC|ETH|BNB|USDT|USDC|DAI|LINK|UNI|AAVE|CAKE|MATIC|SOL|DOT|ADA|XRP|DOGE|SHIB)?\b/i
  const amountMatch = text.match(amountRegex)
  if (amountMatch) {
    functionArgs.amount = amountMatch[1]
    if (amountMatch[3] && !functionArgs.token_symbol) {
      functionArgs.token_symbol = amountMatch[3].toUpperCase()
    }
  }

  // Add default arguments based on function name
  switch (functionName) {
    case "get_token_balance":
      functionArgs = {
        wallet_address: functionArgs.wallet_address || "0xYourWalletAddressHere",
        token_address: functionArgs.token_address || "native",
        ...functionArgs,
      }
      break
    case "get_token_price":
      functionArgs = {
        token_symbol: functionArgs.token_symbol || "BNB",
        ...functionArgs,
      }
      break
    case "get_gas_price":
      functionArgs = {
        chain: functionArgs.chain || "ethereum",
        ...functionArgs,
      }
      break
    case "send_token":
      functionArgs = {
        from_address: functionArgs.from_address || functionArgs.wallet_address || "0xYourWalletAddressHere",
        to_address: functionArgs.to_address || "0xRecipientAddressHere",
        amount: functionArgs.amount || "0.1",
        token_address: functionArgs.token_address || "native",
        ...functionArgs,
      }
      break
    case "swap_tokens":
      functionArgs = {
        token_in: functionArgs.token_in || "BNB",
        token_out: functionArgs.token_out || "BUSD",
        amount_in: functionArgs.amount_in || functionArgs.amount || "0.1",
        slippage: functionArgs.slippage || "0.5",
        ...functionArgs,
      }
      break
  }

  return { text, functionName, functionArgs }
}

// Create a function call object
export function createFunctionCall(name: string, args: Record<string, any>): FunctionCall {
  return {
    id: uuidv4(),
    name,
    arguments: args,
    status: "pending",
  }
}

// Check if a function is read-only (can be auto-executed)
export function isReadOnlyFunction(name: string): boolean {
  const readOnlyFunctions = [
    "get_token_balance",
    "get_token_price",
    "get_gas_price",
    "explain_transaction",
    "estimate_gas",
  ]

  return readOnlyFunctions.includes(name)
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const createDefaultWeb3Tools = (): string => {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_token_price",
        description: "Get the price of a token in USD",
        parameters: {
          type: "object",
          properties: {
            token_symbol: {
              type: "string",
              description: "The token symbol (e.g., ETH, BTC, SOL)",
            },
          },
          required: ["token_symbol"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_gas_price",
        description: "Get the current gas price in Gwei",
        parameters: {
          type: "object",
          properties: {
            chain: {
              type: "string",
              description: "The blockchain to get gas price for (e.g., ethereum, binance)",
            },
          },
          required: ["chain"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "send_token",
        description: "Send tokens to an address",
        parameters: {
          type: "object",
          properties: {
            token_address: {
              type: "string",
              description: "The token address (use 'native' for ETH, BNB, etc.)",
            },
            to_address: {
              type: "string",
              description: "The recipient address",
            },
            amount: {
              type: "string",
              description: "The amount to send",
            },
          },
          required: ["token_address", "to_address", "amount"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "swap_tokens",
        description: "Swap tokens on a decentralized exchange",
        parameters: {
          type: "object",
          properties: {
            token_in: {
              type: "string",
              description: "The input token address or symbol",
            },
            token_out: {
              type: "string",
              description: "The output token address or symbol",
            },
            amount_in: {
              type: "string",
              description: "The input amount",
            },
          },
          required: ["token_in", "token_out", "amount_in"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_liquidity",
        description: "Add liquidity to a DEX pool",
        parameters: {
          type: "object",
          properties: {
            token_a: {
              type: "string",
              description: "First token address or symbol",
            },
            token_b: {
              type: "string",
              description: "Second token address or symbol",
            },
            amount_a: {
              type: "string",
              description: "Amount of first token",
            },
            amount_b: {
              type: "string",
              description: "Amount of second token",
            },
          },
          required: ["token_a", "token_b", "amount_a", "amount_b"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_token_balance",
        description: "Get token balance for an address",
        parameters: {
          type: "object",
          properties: {
            token_address: {
              type: "string",
              description: "The token address (use 'native' for ETH, BNB, etc.)",
            },
            wallet_address: {
              type: "string",
              description: "The wallet address to check balance for",
            },
          },
          required: ["token_address", "wallet_address"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "explain_transaction",
        description: "Explain a blockchain transaction",
        parameters: {
          type: "object",
          properties: {
            transaction_hash: {
              type: "string",
              description: "The transaction hash to explain",
            },
            chain_id: {
              type: "string",
              description: "The chain ID (e.g., 1 for Ethereum, 56 for BSC)",
            },
          },
          required: ["transaction_hash", "chain_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "estimate_gas",
        description: "Estimate gas cost for a transaction",
        parameters: {
          type: "object",
          properties: {
            from_address: {
              type: "string",
              description: "The sender address",
            },
            to_address: {
              type: "string",
              description: "The recipient address",
            },
            data: {
              type: "string",
              description: "The transaction data (hex)",
            },
            value: {
              type: "string",
              description: "The transaction value in wei",
            },
          },
          required: ["from_address", "to_address"],
        },
      },
    },
  ]

  return JSON.stringify(tools)
}

// Execute a function call (mock implementation)
export const executeFunctionCall = async (functionCall: FunctionCall): Promise<any> => {
  // This is a mock implementation - in a real app, you would connect to actual blockchain services
  console.log(`Executing function: ${functionCall.name}`, functionCall.arguments)

  // Simulate a delay
  await new Promise((resolve) => setTimeout(resolve, 1000))

  // Return mock results based on the function name
  let result

  switch (functionCall.name) {
    case "get_token_price":
      const tokenPrices: Record<string, number> = {
        BTC: 65432.78,
        ETH: 3456.89,
        BNB: 567.23,
        SOL: 145.67,
        AVAX: 34.56,
        MATIC: 0.89,
        DOT: 7.65,
        ADA: 0.45,
        XRP: 0.56,
      }

      const symbol = functionCall.arguments.token_symbol?.toUpperCase() || "BTC"
      result = {
        price: tokenPrices[symbol] || Math.floor(Math.random() * 10000) / 100,
        currency: "USD",
        timestamp: Date.now(),
      }
      break

    case "get_gas_price":
      const chainGasPrices: Record<string, number> = {
        ethereum: 25,
        binance: 5,
        polygon: 80,
        avalanche: 30,
        solana: 0.001,
        arbitrum: 0.1,
        optimism: 0.05,
      }

      const chain = functionCall.arguments.chain?.toLowerCase() || "binance"
      result = {
        price: chainGasPrices[chain] || Math.floor(Math.random() * 100),
        unit: "Gwei",
        timestamp: Date.now(),
      }
      break

    case "send_token":
      result = {
        txHash: `0x${Array(64)
          .fill(0)
          .map(() => Math.floor(Math.random() * 16).toString(16))
          .join("")}`,
        status: "pending",
        timestamp: Date.now(),
      }
      break

    case "swap_tokens":
      result = {
        txHash: `0x${Array(64)
          .fill(0)
          .map(() => Math.floor(Math.random() * 16).toString(16))
          .join("")}`,
        amountOut: (Number.parseFloat(functionCall.arguments.amount_in || "1") * (0.9 + Math.random() * 0.2)).toFixed(
          6,
        ),
        status: "pending",
        timestamp: Date.now(),
      }
      break

    case "add_liquidity":
      result = {
        txHash: `0x${Array(64)
          .fill(0)
          .map(() => Math.floor(Math.random() * 16).toString(16))
          .join("")}`,
        lpTokens: (Number.parseFloat(functionCall.arguments.amount_a || "1") * Math.random()).toFixed(6),
        status: "pending",
        timestamp: Date.now(),
      }
      break

    case "get_token_balance":
      // Provide consistent mock balances for common tokens
      const tokenBalances: Record<string, number> = {
        native: 42.38, // BNB, ETH, etc.
        "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c": 156.78, // WBNB
        "0x55d398326f99059fF775485246999027B3197955": 1250.45, // USDT on BSC
        "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d": 980.23, // USDC on BSC
        "0x2170Ed0880ac9A755fd29B2688956BD959F933F8": 5.67, // ETH on BSC
      }

      const tokenAddress = functionCall.arguments.token_address || "native"
      const balance = tokenBalances[tokenAddress] || (Math.random() * 100).toFixed(6)
      const walletAddress = functionCall.arguments.wallet_address || "0x1234...abcd"

      result = {
        balance: balance,
        token: tokenAddress === "native" ? "BNB" : "TOKEN",
        wallet_address: walletAddress,
        timestamp: Date.now(),
        token_address: tokenAddress,
        debug_info: {
          function_name: "get_token_balance",
          arguments: functionCall.arguments,
          mock_data: true,
        },
      }
      break

    case "explain_transaction":
      result = {
        type: Math.random() > 0.5 ? "Transfer" : "Contract Interaction",
        value: (Math.random() * 10).toFixed(4) + " ETH",
        status: Math.random() > 0.2 ? "Success" : "Failed",
        timestamp: Date.now() - Math.floor(Math.random() * 1000000),
      }
      break

    case "estimate_gas":
      result = {
        gas: Math.floor(21000 + Math.random() * 100000),
        gasPrice: Math.floor(Math.random() * 100),
        totalCost: (Math.random() * 0.1).toFixed(6) + " ETH",
        timestamp: Date.now(),
      }
      break

    default:
      result = {
        error: "Function not implemented",
        timestamp: Date.now(),
      }
  }

  console.log(`Function ${functionCall.name} executed with result:`, result)
  return result
}
