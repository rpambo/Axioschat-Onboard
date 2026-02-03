"use client"

import type React from "react"
import { useState, useRef, useEffect } from "react"
import { v4 as uuidv4 } from "uuid"
import Header from "@/components/Header"
import ChatHistory from "@/components/ChatHistory"
import ChatMessages from "@/components/ChatMessages"
import SuggestedPromptsPanel from "@/components/SuggestedPromptsPanel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/use-toast"
import { cn, useAB } from "@/lib/utils"
import { useAccount } from "wagmi"
import WalletRequired from "@/components/WalletRequired"
import { ArrowRight, Bot, MessageSquare, RotateCcw, Sparkles, Send, Command, CircleHelp } from "lucide-react"
import TransactionQueue from "@/components/TransactionQueue"
import useApiKeys from "@/hooks/useApiKeys"
import { useLocation } from "react-router-dom"
import {
  callLlama,
  callOpenAI,
  isReadOnlyFunction,
  executeFunctionCall,
  callFlockWeb3,
  createDefaultWeb3Tools,
  type ChatMessage,
  type FunctionCall,
} from "@/services/aiService"
import ReactMarkdown from "react-markdown"
import ErrorBoundary from "@/components/ErrorBoundary"

type Message = {
  role: "user" | "assistant" | "system" | "function"
  content: string
  id: string
  functionCalls?: FunctionCall[]
  name?: string
}

const Chat = () => {
  const variant = useAB('/chat')
  const { isConnected, address } = useAccount()
  const [loading, setLoading] = useState(false)
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<Message[]>([])
  const [functionCalls, setFunctionCalls] = useState<FunctionCall[]>([])
  // AIML API mode; no Sensay or local Llama selection
  const [useOpenAI, setUseOpenAI] = useState(true)
  const [useSensay, setUseSensay] = useState(false)
  const [activeChat, setActiveChat] = useState<number | null>(null)
  const [isHistoryPanelCollapsed, setIsHistoryPanelCollapsed] = useState(window.innerWidth < 1200)
  const [isPromptsPanelCollapsed, setIsPromptsPanelCollapsed] = useState(window.innerWidth < 1400)
  const [currentChain, setCurrentChain] = useState(1) // Ethereum mainnet
  const [processingMessageId, setProcessingMessageId] = useState<string | null>(null)
  const [executingFunction, setExecutingFunction] = useState(false)
  const [debugMode, setDebugMode] = useState(false)

  const [showEndpointSettings, setShowEndpointSettings] = useState(false)
  const { apiKeys, updateApiKey, isLoaded } = useApiKeys()
  const replicateApiKey = ""

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages])

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1400) {
        setIsPromptsPanelCollapsed(true)
      }
      if (window.innerWidth < 1200) {
        setIsHistoryPanelCollapsed(true)
      }
    }

    handleResize()

    window.addEventListener("resize", handleResize)

    return () => window.removeEventListener("resize", handleResize)
  }, [])

  // Check for question parameter in URL and auto-submit
  const location = useLocation()
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search)
    const questionParam = queryParams.get("question")

    if (questionParam && messages.length === 0 && !loading) {
      // Set the input and trigger submission
      setInput(questionParam)

      // Use setTimeout to ensure the input is set before submitting
      setTimeout(() => {
        const submitEvent = new Event("submit", { cancelable: true })
        const formElement = document.querySelector("form")
        if (formElement) {
          formElement.dispatchEvent(submitEvent)
        }
      }, 100)

      // Clean up the URL to remove the question parameter
      window.history.replaceState({}, document.title, "/chat")
    }
  }, [location.search, messages.length, loading])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading || executingFunction) return;

    // Create a copy of the user's input before clearing it
    const userInput = input.trim();

    const userMessage: Message = {
      role: "user",
      content: userInput,
      id: uuidv4(),
    };

    try {
      // First add the message to the state, then clear input and set loading
      setMessages((prevMessages) => [...prevMessages, userMessage]);
      setInput("");
      setLoading(true);

      // Execute the rest of the function in a try-catch block to prevent UI from disappearing
    try {
      // Prepare messages for the model
      const conversationalMessages: ChatMessage[] = messages
        .filter((m) => m.role !== 'function') // Exclude raw function result messages from AI context
        .map((m) => ({
          role: m.role,
          content: m.content,
          functionCalls: m.functionCalls,
          name: m.name,
        }));

      // Add the new user message
      conversationalMessages.push({
        role: "user",
          content: userInput,
        });

      // Add system message to guide the model to ONLY identify if a function call is needed
      conversationalMessages.unshift({
        role: "system",
          content: `You are Axoischat, a specialized Web3 assistant with deep knowledge of blockchain, cryptocurrencies, DeFi, NFTs, and smart contracts.

Your ONLY job is to determine if the user's request requires calling a blockchain function.

If the user asks for information that requires accessing blockchain data (like balances, prices, etc.), respond with:
1. A brief message indicating you need to check that information
2. Include the tag [FUNCTION_NEEDED] at the end of your message

Available functions:
- get_token_balance - For checking token balances
- get_token_price - For checking token prices
- get_gas_price - For checking gas prices
- send_token - For sending tokens
- swap_tokens - For swapping tokens
- add_liquidity - For adding liquidity

Example:
User: "What's my BNB balance?"
You: "Let me check your BNB balance for you. [FUNCTION_NEEDED]"

User: "Tell me about Ethereum"
You: "Ethereum is a decentralized blockchain platform that enables the creation of smart contracts and decentralized applications (dApps)..."

DO NOT try to execute functions yourself. DO NOT include any specific function names in your response.
DO NOT make up any blockchain data. ONLY identify if a function call is needed.`,
        });

      // Call the model to determine if a function call is needed
      let llamaResponse: string;
      let detectionResponse: string | undefined;

      if (useSensay) {
        // For Sensay model, use AIML API for function detection first
        try {
          detectionResponse = await callOpenAI(
            {
              model: "gpt-4o",
              messages: conversationalMessages,
              temperature: 0.7,
              top_p: 0.9,
              max_tokens: 2000,
            },
            false // useSensay false for AIML detection
          );
        } catch (error) {
          console.error("Error calling AIML API for function detection:", error);
          detectionResponse = "Sorry, I'm having trouble connecting to the AI service. Please try again in a moment.";
        }
        // Use detection response initially
        llamaResponse = detectionResponse;
        // If no function is needed, fetch actual response from Sensay
        if (!detectionResponse.includes("[FUNCTION_NEEDED]")) {
          const { sensay: SENSAY_API_KEY } = apiKeys;
          if (!SENSAY_API_KEY) {
            llamaResponse = "Please provide a Sensay API key in the settings to use the chatbot.";
          } else {
            try {
              llamaResponse = await callLlama(
                {
                  messages: conversationalMessages,
                  temperature: 0.7,
                  top_p: 0.9,
                  max_tokens: 2000
                },
                "",  // Empty endpoint as we're not using Llama
                true // Set useSensay to true
              );
            } catch (error) {
              console.error("Error calling Sensay:", error);
              llamaResponse = "Sorry, I'm having trouble connecting to the Sensay service. Please try again in a moment.";
            }
          }
        }
      } else if (useOpenAI) {
          // Use AIML API directly; backend holds the key
          try {
            llamaResponse = await callOpenAI({
              model: "gpt-4o",
              messages: conversationalMessages,
              temperature: 0.7,
              top_p: 0.9,
              max_tokens: 2000,
            }, false)
          } catch (error) {
            console.error("Error calling OpenAI:", error)
            llamaResponse = "Sorry, I'm having trouble connecting to the AI service. Please try again in a moment."
          }
      } else {
        // Use Llama
          try {
        llamaResponse = await callLlama(
          {
            messages: conversationalMessages,
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 2000,
          },
          "",  // Empty endpoint as we're not using Llama
          false // Set useSensay to false
            );
          } catch (error) {
            console.error("Error calling Llama:", error);
            llamaResponse = "Sorry, I'm having trouble connecting to the AI service. Please try again in a moment.";
          }
        }

      console.log("AI response:", llamaResponse);

      // Determine if a function call is needed
      const functionNeeded = detectionResponse
        ? detectionResponse.includes("[FUNCTION_NEEDED]")
        : llamaResponse.includes("[FUNCTION_NEEDED]");

      // Clean up the response by removing the tag
      const cleanResponse = llamaResponse.replace("[FUNCTION_NEEDED]", "").trim();

      // Add the assistant's message
      const assistantMessage: Message = {
        role: "assistant",
        content: cleanResponse,
        id: uuidv4(),
        };
        setMessages((prevMessages) => [...prevMessages, assistantMessage]);

      // If a function call is needed
      if (functionNeeded) {
          console.log("Function call needed according to Llama");

        // Set a processing message ID to track this operation
          const processingId = uuidv4();
          setProcessingMessageId(processingId);

        // Add a processing message
        const processingMessage: Message = {
          role: "assistant",
          content: "I'm checking that information for you...",
          id: processingId,
          };
          setMessages((prevMessages) => [...prevMessages, processingMessage]);

        // Now forward the request to the Flock Web3 model
        try {
            setExecutingFunction(true);

          // Check if Replicate API key is available
          // Do not enforce frontend key gate; backend loads key from env

          // Get the tools JSON
            const tools = createDefaultWeb3Tools();

            console.log("Calling Flock Web3 model with query:", userInput);

          // Call the Flock Web3 model to determine the specific function and parameters
            try {
          const flockResponse = await callFlockWeb3({
                query: userInput,
                tools: tools,
                temperature: 0.7,
                top_p: 0.9,
                max_new_tokens: 2000,
                // Include message history for better context
                messages: messages.map(msg => ({
                  role: msg.role,
                  content: msg.content,
                  name: msg.name
                })).slice(-10) // Only include last 10 messages to avoid context length issues
              });

              console.log("Flock Web3 response:", flockResponse);

          if (typeof flockResponse === "string") {
                throw new Error("Unexpected string response from Flock Web3");
          }

          if (flockResponse.error) {
                throw new Error(flockResponse.error);
          }

              if (flockResponse.functionCalls && flockResponse.functionCalls.length > 0) {
            // We got function calls from Flock Web3
                const functionCall = flockResponse.functionCalls[0];
                console.log("Function call from Flock Web3:", functionCall);

            // Add to function calls state
                setFunctionCalls((prev) => [...prev, functionCall]);

            // If it's a read-only function, execute it directly
            if (isReadOnlyFunction(functionCall.name)) {
                  console.log("Auto-executing read-only function");
              try {
                    const result = await executeFunctionCall(functionCall);
                    console.log("Function execution result:", result);

                // Add the function result as a function message
                const functionMessage: Message = {
                  role: "function",
                  name: functionCall.name,
                  content: JSON.stringify(
                    {
                      function_name: functionCall.name,
                      arguments: functionCall.arguments,
                      result: result,
                      timestamp: new Date().toISOString(),
                    },
                    null,
                    2,
                  ),
                  id: uuidv4(),
                    };
                    setMessages((prev) => [...prev, functionMessage]);

                // Update the function call status
                setFunctionCalls((prev) =>
                  prev.map((f) => (f.id === functionCall.id ? { ...f, status: "executed", result } : f)),
                    );

                // Format the result for the Llama model
                    const formattedResult = JSON.stringify(result);

                // Send the result back to the Llama model for interpretation
                // No need to look up the function, we already have it
                const interpretationMessages: ChatMessage[] = [
                  {
                    role: "system",
                    content: "You are a specialized Web3 assistant called Axioschat. Do not mention that this data is simulated or mock. Present the information as if it were retrieved from a real blockchain.",
                  },
                  {
                    role: "user",
                    content: `Function "${functionCall.name}" executed with arguments ${JSON.stringify(functionCall.arguments)}.\n
Result: ${formattedResult}\n
Please explain what this result means for the user in a concise and helpful way. Interpret the function result and respond in a natural, conversational way. Focus on explaining what the data means for the user in plain language.

Be concise and direct. Don't just repeat the raw data - explain its significance in a helpful way.`,
                  },
                ];

                console.log("Sending function result to Llama for interpretation");

                // Call the Llama model again to interpret the result
                    let interpretationResponse: string;

                if (useOpenAI) {
                  interpretationResponse = await callOpenAI({
                    model: "gpt-4o",
                    messages: interpretationMessages,
                    temperature: 0.7,
                    top_p: 0.9,
                    max_tokens: 2000,
                  })
                } else if (useSensay) {
                    interpretationResponse = await callLlama(
                        {
                            messages: interpretationMessages,
                            temperature: 0.7,
                            top_p: 0.9,
                            max_tokens: 2000,
                        },
                        "",  // Empty endpoint as we're not using Llama
                        true
                    );
                } else {
                    interpretationResponse = await callLlama(
                        {
                            messages: interpretationMessages,
                            temperature: 0.7,
                            top_p: 0.9,
                            max_tokens: 2000,
                        },
                        "",  // Empty endpoint as we're not using Llama
                        false
                    );
                }

                    console.log("Interpretation response:", interpretationResponse);

                // Replace the processing message with the interpretation
                if (interpretationResponse && !interpretationResponse.includes("No valid response from")) {
                  setMessages((prevMessages) =>
                    prevMessages.map((msg) =>
                      msg.id === processingId
                        ? {
                            ...msg,
                            content: interpretationResponse,
                          }
                        : msg,
                    ),
                      );
                } else {
                  // Use fallback response if interpretation fails
                      const fallbackResponse = generateFallbackResponse(functionCall, result);
                  setMessages((prevMessages) =>
                    prevMessages.map((msg) =>
                      msg.id === processingId
                        ? {
                            ...msg,
                            content: fallbackResponse,
                          }
                        : msg,
                    ),
                      );
                }
              } catch (error) {
                    console.error("Error executing function:", error);

                // Update the processing message with the error
                setMessages((prevMessages) =>
                  prevMessages.map((msg) =>
                    msg.id === processingId
                      ? {
                          ...msg,
                          content: `I encountered an error while checking that information: ${
                            error instanceof Error ? error.message : "Unknown error"
                          }`,
                        }
                      : msg,
                  ),
                    );

                // Update the function call status
                setFunctionCalls((prev) =>
                  prev.map((f) =>
                    f.id === functionCall.id
                      ? {
                          ...f,
                          status: "rejected",
                          result: { error: error instanceof Error ? error.message : "Unknown error" },
                        }
                      : f,
                  ),
                    );
              }
            } else {
              // For non-read-only functions, show bottom approval pop
              setMessages((prevMessages) =>
                prevMessages.map((msg) =>
                  msg.id === processingId
                    ? {
                        ...msg,
                        content: `Action required: approve ${functionCall.name} below to continue.`,
                      }
                    : msg,
                ),
              );
              // Add to queue
              setFunctionCalls((prev) => [...prev, functionCall])
            }
              } else {
                // No function calls returned
            setMessages((prevMessages) =>
              prevMessages.map((msg) =>
                msg.id === processingId
                  ? {
                      ...msg,
                          content: "I couldn't determine the specific function needed. Could you please provide more details?",
                    }
                  : msg,
              ),
                );
              }
            } catch (flockError) {
              console.error("Error calling Flock Web3:", flockError);
              setMessages((prevMessages) =>
                prevMessages.map((msg) =>
                  msg.id === processingId
                    ? {
                        ...msg,
                        content: `I encountered an error while processing your request: ${
                          flockError instanceof Error ? flockError.message : "Unknown error"
                        }`,
                      }
                    : msg,
                ),
              );
          }
        } catch (error) {
            console.error("Error in function execution flow:", error);
          setMessages((prevMessages) =>
            prevMessages.map((msg) =>
              msg.id === processingId
                ? {
                    ...msg,
                    content: `I encountered an error while processing your request: ${
                      error instanceof Error ? error.message : "Unknown error"
                    }`,
                  }
                : msg,
            ),
            );
        } finally {
            setExecutingFunction(false);
            setProcessingMessageId(null);
          }
        }
      } catch (innerError) {
        console.error("Error in handleSubmit inner logic:", innerError);
        // Add an error message
        setMessages((prevMessages) => [
          ...prevMessages,
          {
        role: "assistant",
            content: "I'm sorry, I encountered an unexpected error. Please try again.",
        id: uuidv4(),
          },
        ]);
      }
    } catch (outerError) {
      console.error("Critical error in handleSubmit:", outerError);
      // Don't try to update state if we hit a critical error
    } finally {
      setLoading(false);
    }
  };

  // New function to execute a function directly
  const generateFallbackResponse = (func: FunctionCall, result: any): string => {
    console.log("Generating fallback response for:", func.name)

    switch (func.name) {
      case "get_token_balance":
        return `Your ${result.token || "token"} balance is ${result.balance} ${
          func.arguments.token_address === "native" ? "BNB" : result.token || "tokens"
        }.`
      case "get_token_price":
        return `The current price of ${func.arguments.token_symbol} is ${result.price} USD.`
      case "send_token":
        return `Transaction sent! ${func.arguments.amount} ${
          func.arguments.token_address === "native" ? "BNB" : "tokens"
        } have been sent to ${func.arguments.to_address}. Transaction hash: ${result.txHash}`
      case "swap_tokens":
        return `Swap completed! You received ${result.amountOut} ${func.arguments.token_out}. Transaction hash: ${result.txHash}`
      case "get_gas_price":
        return `The current gas price is ${result.price} ${result.unit}.`
      default:
        return `Function ${func.name} executed successfully: ${JSON.stringify(result, null, 2)}`
    }
  }

  // Update the handleFunctionStatusChange function to use the new executeFunction
  const handleFunctionStatusChange = async (id: string, status: "approved" | "rejected" | "executed", result?: any) => {
    console.log(`Function status change: ${id} -> ${status}`, result ? "with result" : "no result")

    // Update the function call status
    setFunctionCalls((prev) =>
      prev.map((func) => (func.id === id ? { ...func, status, result: result || func.result } : func)),
    )

    // If function was approved, execute it
    if (status === "approved" && !executingFunction) {
      const func = functionCalls.find((f) => f.id === id)
      if (!func) {
        console.error("Function not found for ID:", id)
        return
      }

      console.log("Executing approved function:", func.name)

      // Set a processing message ID to track this operation
      const processingId = uuidv4()
      setProcessingMessageId(processingId)

      // Add a processing message
      const processingMessage: Message = {
        role: "assistant",
        content: "I'm processing your request...",
        id: processingId,
      }
      setMessages((prevMessages) => [...prevMessages, processingMessage])

      // Execute the function
      setExecutingFunction(true)
      try {
        const result = await executeFunctionCall(func)
        console.log("Function execution result:", result)

        // Update the function call status
        setFunctionCalls((prev) => prev.map((f) => (f.id === func.id ? { ...f, status: "executed", result } : f)))

        // Format the result for the Llama model
        const formattedResult = JSON.stringify(result)

        // Send the result back to the Llama model for interpretation
        const interpretationMessages: ChatMessage[] = [
          {
            role: "system",
            content: "You are a specialized Web3 assistant. Do not mention that this data is simulated or mock. Present the information as if it were retrieved from a real blockchain.",
          },
          {
            role: "user",
            content: `Function "${func.name}" executed with arguments ${JSON.stringify(func.arguments)}.\n
Result: ${formattedResult}\n
Please explain what this result means for the user in a concise and helpful way.`,
          },
        ];

        console.log("Sending function result to Llama for interpretation")

        // Call the Llama model again to interpret the result
        let interpretationResponse: string

                if (useOpenAI) {
                  interpretationResponse = await callOpenAI({
                    model: "gpt-4o",
                    messages: interpretationMessages,
                    temperature: 0.7,
                    top_p: 0.9,
                    max_tokens: 2000,
                  })
        } else if (useSensay) {
          interpretationResponse = await callLlama(
            {
              messages: interpretationMessages,
              temperature: 0.7,
              top_p: 0.9,
              max_tokens: 2000,
            },
            "",  // Empty endpoint as we're not using Llama
            true
          )
        } else {
          interpretationResponse = await callLlama(
            {
              messages: interpretationMessages,
              temperature: 0.7,
              top_p: 0.9,
              max_tokens: 2000,
            },
            "",  // Empty endpoint as we're not using Llama
            false
          )
        }

        console.log("Interpretation response:", interpretationResponse)

        // Replace the processing message with the interpretation
        if (interpretationResponse && !interpretationResponse.includes("No valid response from")) {
          setMessages((prevMessages) =>
            prevMessages.map((msg) =>
              msg.id === processingId
                ? {
                    ...msg,
                    content: interpretationResponse,
                  }
                : msg,
            ),
          )
        } else {
          // Use fallback response if interpretation fails
          const fallbackResponse = generateFallbackResponse(func, result)
          setMessages((prevMessages) =>
            prevMessages.map((msg) =>
              msg.id === processingId
                ? {
                    ...msg,
                    content: fallbackResponse,
                  }
                : msg,
            ),
          )
        }

        // Add the function result as a function message
        const functionMessage: Message = {
          role: "function",
          name: func.name,
          content: JSON.stringify(
            {
              function_name: func.name,
              arguments: func.arguments,
              result: result,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
          id: uuidv4(),
        }

        setMessages((prev) => [...prev, functionMessage])

        // If the function generated a transaction, add it to the transaction queue
        if (result.txHash && window.transactionQueue) {
          window.transactionQueue.add({
            hash: result.txHash,
            from: address || "",
            to: func.arguments.to_address || "",
            value: func.arguments.amount || "0",
            chainId: String(currentChain),
            type: func.name,
            status: "confirmed",
            method: func.name,
            timestamp: Date.now(),
            description: `${func.name} - ${func.arguments.amount || ""} ${
              func.arguments.token_address === "native" ? "BNB" : "tokens"
            }`,
            execute: async () => {},
          })
        }
      } catch (error) {
        console.error("Error executing function:", error)

        // Update the processing message with the error
        setMessages((prevMessages) =>
          prevMessages.map((msg) =>
            msg.id === processingId
              ? {
                  ...msg,
                  content: `I encountered an error while processing your request: ${
                    error instanceof Error ? error.message : "Unknown error"
                  }`,
                }
              : msg,
          ),
        )

        // Update the function call status
        setFunctionCalls((prev) =>
          prev.map((f) =>
            f.id === func.id
              ? {
                  ...f,
                  status: "rejected",
                  result: { error: error instanceof Error ? error.message : "Unknown error" },
                }
              : f,
          ),
        )
      } finally {
        setProcessingMessageId(null)
        setExecutingFunction(false)
      }
    }
  }

  const handleSuggestedQuestion = (question: string) => {
    setInput(question)
  }

  const clearChat = () => {
    setMessages([])
    setFunctionCalls([])
    toast({
      title: "Chat cleared",
      description: "All chat messages have been removed.",
    })
  }

  const handleSelectChat = (chatId: number, chatMessages: Array<{ role: string; content: string }>) => {
    setActiveChat(chatId)
    const formattedMessages = chatMessages.map((msg, index) => ({
      role: msg.role as "user" | "assistant" | "system" | "function",
      content: msg.content,
      id: `history-${chatId}-${index}`,
    }))
    setMessages(formattedMessages)
    setFunctionCalls([])
  }

  const handleNewChat = () => {
    setActiveChat(null)
    setMessages([])
    setFunctionCalls([])
  }

  // Calculate content area width based on panel states
  const getContentWidth = () => {
    const baseClasses = "flex flex-col rounded-xl border h-full max-h-full overflow-hidden transition-all duration-300 bg-background/50 backdrop-blur-sm"

    // Both panels are expanded
    if (!isHistoryPanelCollapsed && !isPromptsPanelCollapsed) {
      return cn(baseClasses, "flex-1")
    }

    // Only history panel is collapsed
    if (isHistoryPanelCollapsed && !isPromptsPanelCollapsed) {
      return cn(baseClasses, "flex-[2]")
    }

    // Only prompts panel is collapsed
    if (!isHistoryPanelCollapsed && isPromptsPanelCollapsed) {
      return cn(baseClasses, "flex-[2]")
    }

    // Both panels are collapsed
    return cn(baseClasses, "flex-[4]")
  }

  return (
    <div className="flex flex-col h-screen bg-gradient-to-b from-background via-background to-background/95">
      <Header />

      <main className="flex-1 container px-0 md:px-4 py-4 flex flex-col max-h-[calc(100vh-4rem)] overflow-hidden">
        {!isConnected ? (
          <div className="flex-1 flex items-center justify-center">
            <WalletRequired />
          </div>
        ) : (
          <ErrorBoundary>
            <div className="grid grid-cols-[auto_1fr_auto] gap-0 md:gap-3 lg:gap-4 h-full max-h-full">
            {/* History Panel */}
            <div
              className={cn(
                "transition-all duration-300 h-full max-h-full overflow-hidden flex flex-col",
                isHistoryPanelCollapsed ? "w-10" : "w-[280px] md:w-[320px]",
              )}
            >
              <div className="flex-1 overflow-hidden">
                <ChatHistory
                  onSelectChat={handleSelectChat}
                  onNewChat={handleNewChat}
                  activeChat={activeChat}
                  currentChain={currentChain}
                  onCollapseChange={setIsHistoryPanelCollapsed}
                  defaultCollapsed={isHistoryPanelCollapsed}
                />
              </div>

              {!isHistoryPanelCollapsed && (
                  <div className="border-t mt-auto p-2 bg-background/50 backdrop-blur-sm rounded-b-xl">
                  <TransactionQueue
                    chainId={currentChain}
                    inPanel={true}
                    functionCalls={functionCalls}
                    onFunctionStatusChange={handleFunctionStatusChange}
                  />
                </div>
              )}
            </div>

            {/* Main Chat Area */}
            <div className={getContentWidth()}>
                <div className="border-b px-5 py-3 flex justify-between items-center flex-shrink-0 bg-muted/30">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-md">
                      <MessageSquare className="h-4 w-4 text-white" />
                    </div>
                  <h2 className="text-sm font-medium">{activeChat ? "Conversation" : "New Chat"}</h2>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearChat}
                    className="text-xs h-8 hover:bg-background/80 hover:text-foreground"
                  disabled={messages.length === 0}
                >
                  <RotateCcw size={14} className="mr-1" />
                  Clear
                </Button>
              </div>

                <div ref={chatContainerRef} className="flex-1 p-6 bg-white dark:bg-gray-800 rounded-xl shadow-md overflow-y-auto space-y-6">
                   {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center text-center p-8 w-full h-full">
                       <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center mb-6 shadow-xl">
                        <Sparkles className="h-12 w-12 text-white" />
                       </div>
                       <h3 className="text-3xl font-bold text-gray-900 dark:text-white">AxiosChat</h3>
                       <h4 className="text-xl font-semibold mt-2 text-gray-600 dark:text-gray-300">Your Web3 AI Assistant</h4>
                    <p className="text-gray-500 dark:text-gray-400 text-sm mt-2 max-w-md">
                        Ask anything about blockchain, crypto, or web3 development. Let's explore together!
                      </p>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-8 max-w-3xl w-full">
                         <Button 
                           variant="outline" 
                           className="p-4 h-auto flex flex-col items-start gap-2 shadow-sm hover:shadow-md transition-all text-left border-muted-foreground/20 hover:border-indigo-500/30 hover:bg-indigo-500/5 group"
                           onClick={() => setInput("What is a blockchain?")}
                         >
                           <div className="p-2 rounded-lg bg-muted/50 group-hover:bg-indigo-500/10 transition-colors">
                             <Command className="h-4 w-4 text-indigo-500" />
                           </div>
                           <span className="font-medium">What is a blockchain?</span>
                         </Button>
                         <Button 
                           variant="outline" 
                           className="p-4 h-auto flex flex-col items-start gap-2 shadow-sm hover:shadow-md transition-all text-left border-muted-foreground/20 hover:border-purple-500/30 hover:bg-purple-500/5 group"
                           onClick={() => setInput("How do smart contracts work?")}
                         >
                           <div className="p-2 rounded-lg bg-muted/50 group-hover:bg-purple-500/10 transition-colors">
                             <CircleHelp className="h-4 w-4 text-purple-500" />
                           </div>
                           <span className="font-medium">How do smart contracts work?</span>
                         </Button>
                         <Button 
                           variant="outline" 
                           className="p-4 h-auto flex flex-col items-start gap-2 shadow-sm hover:shadow-md transition-all text-left border-muted-foreground/20 hover:border-pink-500/30 hover:bg-pink-500/5 group"
                           onClick={() => setInput("Explain DeFi in simple terms")}
                         >
                           <div className="p-2 rounded-lg bg-muted/50 group-hover:bg-pink-500/10 transition-colors">
                             <CircleHelp className="h-4 w-4 text-pink-500" />
                           </div>
                           <span className="font-medium">Explain DeFi in simple terms</span>
                         </Button>
                       </div>
                  </div>
                ) : (
                  <ChatMessages
                    messages={messages
                      .filter((m) => m.role !== "function" || debugMode)
                      .map((m) => ({ role: m.role, content: m.content }))}
                    isTyping={loading || executingFunction}
                  />
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="border-t p-4 md:p-5 flex-shrink-0 bg-white dark:bg-gray-800 rounded-b-xl shadow-inner relative">
                <div className="absolute inset-0 bg-gradient-to-r from-indigo-100 to-purple-100 dark:from-gray-700 dark:to-gray-800 opacity-20 pointer-events-none"></div>
                {/* Model selection removed: AIML API only */}
                <ErrorBoundary>
                  <form onSubmit={(e) => { e.preventDefault(); if (input.trim()) handleSubmit(e); }} className="flex items-center space-x-3 relative z-10">
                    <Input
                      placeholder="Type your message..."
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      className="flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-full focus:outline-none"
                    />
                    <Button
                      type="button"
                      onClick={(e) => handleSubmit(e as unknown as React.FormEvent)}
                      disabled={loading || !input.trim() || executingFunction}
                      className="p-3 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow"
                    >
                      <Send className="h-5 w-5" />
                    </Button>
                  </form>
                </ErrorBoundary>
              </div>
            </div>

            {/* Suggested Prompts Panel */}
            <div
              className={cn(
                "transition-all duration-300 h-full max-h-full overflow-hidden",
                isPromptsPanelCollapsed ? "w-10" : "w-[260px] lg:w-[300px]",
              )}
            >
              <SuggestedPromptsPanel
                onSelectQuestion={handleSuggestedQuestion}
                onCollapseChange={setIsPromptsPanelCollapsed}
                defaultCollapsed={isPromptsPanelCollapsed}
              />
            </div>
          </div>
          </ErrorBoundary>
        )}
      </main>
      {isHistoryPanelCollapsed && (
        <TransactionQueue
          chainId={currentChain}
          functionCalls={functionCalls}
          onFunctionStatusChange={handleFunctionStatusChange}
        />
      )}
    </div>
  )
}

export default Chat
