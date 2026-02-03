// This is a Vercel serverless function that acts as a proxy for AIML API
// to avoid CORS issues with browser-based requests
export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request) {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-AIMLAPI-Key',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  try {
    // Only allow POST requests for actual API calls
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({
        error: 'Method not allowed'
      }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Prefer header; fallback to server env for production deploys
    const apiToken = req.headers.get('X-AIMLAPI-Key') || process.env.AIMLAPI_KEY || process.env.VITE_AIMLAPI_KEY || '';
    if (!apiToken) {
      console.error('Missing AIML API key in headers');
      return new Response(JSON.stringify({
        error: 'AIML API token is required',
        details: 'The X-AIMLAPI-Key header is missing or empty'
      }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Log that we received a key (mask most of it for security)
    const maskedKey = apiToken.substring(0, 8) + '...' + apiToken.substring(apiToken.length - 4);
    console.log(`Received API key in aiml-proxy: ${maskedKey}`);

    // Parse the request body
    let requestData;
    try {
      requestData = await req.json();
    } catch (error) {
      return new Response(JSON.stringify({
        error: 'Failed to parse request body',
        details: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (!requestData) {
      return new Response(JSON.stringify({
        error: 'Request body is required'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    console.log('Alternative proxy handling request for AIML API');

    // Extract parameters from the request (already in OpenAI format)
    const {
      model = 'gpt-4o',
      messages,
      temperature = 0.7,
      max_tokens = 2000
    } = requestData;

    // AIML API uses OpenAI-compatible format, so no conversion needed
    console.log(`Making request to AIML API with model: ${model}`);

    const response = await fetch('https://api.aimlapi.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens
      })
    });

    // Check if the response is OK
    if (!response.ok) {
      let errorText;
      try {
        errorText = await response.text();
        console.error(`AIML API error (${response.status}):`, errorText);
      } catch (error) {
        errorText = 'Could not read error response';
      }
      
      return new Response(JSON.stringify({
        error: `AIML API returned ${response.status}`,
        details: errorText
      }), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Get the response data
    let responseData;
    try {
      responseData = await response.json();
      console.log('Received response from AIML API');
    } catch (error) {
      return new Response(JSON.stringify({
        error: 'Failed to parse AIML API response',
        details: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // AIML API already returns OpenAI-compatible format, so just pass it through
    // Return the response
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', 
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-AIMLAPI-Key'
      }
    });
  } catch (error) {
    console.error('Error in aiml-proxy:', error);
    
    return new Response(JSON.stringify({
      error: 'Proxy server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      stack: error instanceof Error ? error.stack : undefined
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
} 