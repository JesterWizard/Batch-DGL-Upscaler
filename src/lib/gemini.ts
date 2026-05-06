import { GoogleGenerativeAI } from "@google/generative-ai";

export async function upscaleImage(imageUrl: string, providedKey?: string | null, guide?: string): Promise<string> {
  try {
    // Model selection: gemini-2.0-flash is currently the best "nano-style" fast model
    const MODEL_ID = 'gemini-2.0-flash';
    
    // Choose the key (provided takes precedence for "Paid" mode)
    let apiKey = (providedKey && providedKey !== 'null' && providedKey !== 'undefined') 
      ? providedKey 
      : process.env.GEMINI_API_KEY;
    
    // Clean up key (remove quotes and spaces)
    if (apiKey && typeof apiKey === 'string') {
      apiKey = apiKey.replace(/['"]/g, '').trim();
    }
    
    // Filter out potential placeholder values
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey === 'undefined' || apiKey === 'null' || apiKey === '') {
      throw new Error(`API_KEY_MISSING: No valid Gemini API key found (Value: ${apiKey}). Please provide a key in Pro mode or set GEMINI_API_KEY in secrets.`);
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: MODEL_ID });

    // Convert blob URL or data URL to base64
    const base64Data = await getBase64FromUrl(imageUrl);
    const [mimePart, data] = base64Data.split(';base64,');
    const mimeType = mimePart.split(':')[1];

    const promptText = guide 
      ? `Act as a professional image upscaler. Follow these specific guidelines for the upscaling process:\n\n${guide}\n\nMaintain stylistic consistency, colors, and textures perfectly. Output ONLY the resulting image data.`
      : 'Act as a professional image upscaler. Analyze this image and output a higher resolution version. Maintain stylistic consistency, colors, and textures perfectly. Output ONLY the resulting image data.';

    const result = await model.generateContent([
      {
        inlineData: {
          data,
          mimeType,
        },
      },
      {
        text: promptText,
      }
    ]);

    const response = await result.response;
    const parts = response.candidates?.[0]?.content?.parts;

    if (parts) {
      for (const part of parts) {
        if (part.inlineData) {
          return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
      }
    }

    // Fallback: If it returned text that looks like base64
    const text = response.text ? response.text() : '';
    if (text.includes('data:image')) {
      const match = text.match(/data:image\/[a-zA-Z]+;base64,[a-zA-Z0-9+/=]+/);
      if (match) return match[0];
    }

    throw new Error('MODEL_OUTPUT_ERROR: The model did not return image data.');
  } catch (error: any) {
    console.error('Nano Banana Error:', error);
    throw error;
  }
}

async function getBase64FromUrl(url: string): Promise<string> {
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Parses Gemini error messages to find a restoration time if present.
 * Example of typical 429 error messages containing delay info.
 */
export function parseRestorationTime(error: any): number | null {
  const message = error?.message || '';
  if (message.includes('429')) {
    // Try to find a duration like "60s" or "1m" or a timestamp
    const secondsMatch = message.match(/(\d+)s/);
    if (secondsMatch) return parseInt(secondsMatch[1]) * 1000;
    
    // Default to a 60-second wait if it's a rate limit but no time was specified
    return 60000;
  }
  return null;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
