import { redisClient } from "../config/redis.js";
import { logger } from "../config/logger.js";
import { VM } from "vm2";
import Campaign from "../models/campaign.schema.js";
import type { ScriptLog } from "../models/campaign.schema.js";
import axios from "axios";
import nodemailer from "nodemailer";

// Define available libraries for scripts
const SCRIPT_LIBRARIES: any = {
  cleanup_script: {
    cheerio: "cheerio", // For HTML parsing
    lodash: "lodash", // For utility functions
  },
  fetch_script: {
    cheerio: "cheerio",
  },
  jobs_cleanup_script: {
    cheerio: "cheerio",
  },
};

// Add this interface near the top of the file
interface BatchAIRequest {
  prompts: string[];
  config?: {
    provider: "claude" | "openai" | "ollama";
    model?: string;
    batchSize?: number;
  };
}

// Add these interfaces near the top of the file
interface OpenAIBatchRequest {
  prompts: string[];
  config?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
  };
}

interface OpenAIBatchResponse {
  batchId: string;
  status: "validating" | "processing" | "completed" | "failed" | "expired";
  inputFileId: string;
  outputFileId?: string;
  errorFileId?: string;
  requestCounts?: {
    total: number;
    completed: number;
    failed: number;
  };
  completions?: Array<{
    message: {
      content: string;
    };
  }>;
  error?: string;
}

// Helper function to get script-specific functions
const getScriptFunctions = async (campaignId: string, scriptType: string) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const callClaudeAI = async (prompt: string) => {
    try {
      if (!process.env.CLAUDE_API_KEY) {
        throw new Error("Claude API key is not configured");
      }

      const response = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-3-opus-20240229",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        },
        {
          headers: {
            "x-api-key": process.env.CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
        }
      );

      return {
        choices: [
          {
            message: {
              content: response.data.content[0].text,
            },
          },
        ],
      };
    } catch (error: any) {
      logger.error("Claude API error:", error?.response?.data || error.message);
      throw new Error(
        `Claude API error: ${
          error?.response?.data?.error?.message || error.message
        }`
      );
    }
  };

  // const callOpenAI = async (prompt: string) => {
  //   try {
  //     if (!process.env.OPENAI_API_KEY) {
  //       throw new Error("OpenAI API key is not configured");
  //     }

  //     const response = await axios.post(
  //       "https://api.openai.com/v1/chat/completions",
  //       {
  //         model: "gpt-3.5-turbo-16k",
  //         messages: [{ role: "user", content: prompt }],
  //       },
  //       {
  //         headers: {
  //           Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  //           "Content-Type": "application/json",
  //         },
  //       }
  //     );

  //     return response.data;
  //   } catch (error: any) {
  //     logger.error("OpenAI API error:", error?.response?.data || error.message);
  //     throw new Error(
  //       `OpenAI API error: ${
  //         error?.response?.data?.error?.message || error.message
  //       }`
  //     );
  //   }
  // };

  // Add a debug log to check if the API key is being passed correctly
  const callOpenAI = async (prompt: string) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OpenAI API key is not configured");
      }

      // Debug log (remove in production)
      console.log("API Key length:", process.env.OPENAI_API_KEY.length);

      console.log("Prompt:", prompt);

      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini", 
          messages: [{ role: "user", content: prompt }],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          }
        }
      );
      console.log("Response:", response.data.choices);
      return response.data;
    } catch (error: any) {
      // Enhanced error logging
      console.error("Full error object:", JSON.stringify(error, null, 2));
      logger.error("OpenAI API error:", error?.response?.data || error.message);
      throw new Error(
        `OpenAI API error: ${
          error?.response?.data?.error?.message || error.message
        }`
      );
    }
  };

  const callOllamaAI = async (prompt: string, model = "mistral") => {
    try {
      if (!process.env.OLLAMA_HOST) {
        throw new Error("Ollama host is not configured");
      }

      const response = await axios.post(
        `${process.env.OLLAMA_HOST}/api/generate`,
        {
          model: model,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
          },
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      // Format response to match OpenAI/Claude structure
      return {
        choices: [
          {
            message: {
              content: response.data.response,
            },
          },
        ],
      };
    } catch (error: any) {
      logger.error("Ollama API error:", error?.response?.data || error.message);
      throw new Error(
        `Ollama API error: ${
          error?.response?.data?.error?.message || error.message
        }`
      );
    }
  };

  // Add batch processing for Claude
  const callClaudeAIBatch = async (prompts: string[], batchSize = 5) => {
    try {
      if (!process.env.CLAUDE_API_KEY) {
        throw new Error("Claude API key is not configured");
      }

      // Process prompts in batches
      const results = [];
      for (let i = 0; i < prompts.length; i += batchSize) {
        const batch = prompts.slice(i, i + batchSize);

        // Create a batch of promises
        const batchPromises = batch.map((prompt) =>
          axios.post(
            "https://api.anthropic.com/v1/messages",
            {
              model: "claude-3-opus-20240229",
              max_tokens: 4096,
              messages: [{ role: "user", content: prompt }],
            },
            {
              headers: {
                "x-api-key": process.env.CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
              },
            }
          )
        );

        // Execute batch
        const batchResponses = await Promise.all(batchPromises);

        // Process responses
        const batchResults = batchResponses.map((response) => ({
          choices: [
            {
              message: {
                content: response.data.content[0].text,
              },
            },
          ],
        }));

        results.push(...batchResults);

        // Add delay between batches if not the last batch
        if (i + batchSize < prompts.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      return results;
    } catch (error: any) {
      logger.error(
        "Claude API batch error:",
        error?.response?.data || error.message
      );
      throw new Error(
        `Claude API batch error: ${
          error?.response?.data?.error?.message || error.message
        }`
      );
    }
  };

  // Add batch processing for OpenAI
  const callOpenAIBatch = async (prompts: string[], batchSize = 5) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OpenAI API key is not configured");
      }

      const results = [];
      for (let i = 0; i < prompts.length; i += batchSize) {
        const batch = prompts.slice(i, i + batchSize);

        // Create a batch of promises
        const batchPromises = batch.map((prompt) =>
          axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
              model: "gpt-4",
              messages: [{ role: "user", content: prompt }],
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
              timeout: 30000,
            }
          )
        );

        // Execute batch
        const batchResponses = await Promise.all(batchPromises);
        results.push(...batchResponses.map((response) => response.data));

        // Add delay between batches if not the last batch
        if (i + batchSize < prompts.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      return results;
    } catch (error: any) {
      logger.error(
        "OpenAI API batch error:",
        error?.response?.data || error.message
      );
      throw new Error(
        `OpenAI API batch error: ${
          error?.response?.data?.error?.message || error.message
        }`
      );
    }
  };

  // Add the batch processing function to the script functions
  const callAIBatch = async ({
    prompts,
    config = { provider: "openai", batchSize: 5 },
  }: BatchAIRequest) => {
    const { provider, batchSize = 5 } = config;

    switch (provider) {
      case "claude":
        return callClaudeAIBatch(prompts, batchSize);
      case "openai":
        return callOpenAIBatch(prompts, batchSize);
      default:
        throw new Error(
          `Batch processing not supported for provider: ${provider}`
        );
    }
  };

  // Add helper function to create JSONL content
  const createBatchJSONL = (prompts: string[], config: any) => {
    return prompts
      .map((prompt, index) => ({
        custom_id: `request-${index + 1}`,
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model: config.model || "gpt-4",
          messages: [
            {
              role: "system",
              content: config.systemPrompt || "You are a helpful assistant.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: config.maxTokens || 4000,
          temperature: config.temperature || 0.7,
        },
      }))
      .map((request) => JSON.stringify(request))
      .join("\n");
  };

  // Update the createOpenAIBatch function
  const createOpenAIBatch = async ({
    prompts,
    config = {
      model: "gpt-4",
      maxTokens: 4000,
      temperature: 0.7,
      systemPrompt: "You are a helpful assistant.",
    },
  }: OpenAIBatchRequest): Promise<OpenAIBatchResponse> => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OpenAI API key is not configured");
      }

      // Create JSONL content
      const jsonlContent = createBatchJSONL(prompts, config);

      // Create a Blob and FormData for file upload
      const blob = new Blob([jsonlContent], { type: "application/jsonl" });
      const formData = new FormData();
      formData.append("file", blob, "requests.jsonl");
      formData.append("purpose", "batches");

      // Upload the file
      const uploadResponse = await axios.post(
        "https://api.openai.com/v1/files",
        formData,
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "multipart/form-data",
          },
        }
      );

      const inputFileId = uploadResponse.data.id;

      // Create batch request
      const batchResponse = await axios.post(
        "https://api.openai.com/v1/batches",
        {
          input_file_id: inputFileId,
          endpoint: "/v1/chat/completions",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      return {
        batchId: batchResponse.data.id,
        status: batchResponse.data.status,
        inputFileId: batchResponse.data.input_file_id,
        outputFileId: batchResponse.data.output_file_id,
        errorFileId: batchResponse.data.error_file_id,
        requestCounts: batchResponse.data.request_counts,
      };
    } catch (error: any) {
      logger.error(
        "OpenAI batch creation error:",
        error?.response?.data || error.message
      );
      throw new Error(
        `OpenAI batch creation error: ${
          error?.response?.data?.error?.message || error.message
        }`
      );
    }
  };

  // Update the retrieveOpenAIBatch function to handle file downloads
  const retrieveOpenAIBatch = async (
    batchId: string
  ): Promise<OpenAIBatchResponse> => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OpenAI API key is not configured");
      }

      // Get batch status
      const batchResponse = await axios.get(
        `https://api.openai.com/v1/batches/${batchId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const batchData = batchResponse.data;

      // If batch is completed and has output file, download results
      let completions: any;
      if (batchData.status === "completed" && batchData.output_file_id) {
        const outputResponse = await axios.get(
          `https://api.openai.com/v1/files/${batchData.output_file_id}/content`,
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
          }
        );

        // Parse JSONL content
        completions = outputResponse.data
          .split("\n")
          .filter(Boolean)
          .map((line: string) => JSON.parse(line));
      }

      return {
        batchId: batchData.id,
        status: batchData.status,
        inputFileId: batchData.input_file_id,
        outputFileId: batchData.output_file_id,
        errorFileId: batchData.error_file_id,
        requestCounts: batchData.request_counts,
        completions,
      };
    } catch (error: any) {
      logger.error(
        "OpenAI batch retrieval error:",
        error?.response?.data || error.message
      );
      throw new Error(
        `OpenAI batch retrieval error: ${
          error?.response?.data?.error?.message || error.message
        }`
      );
    }
  };

  switch (scriptType) {
    case "cleanup_script":
      return {
        GetChampainRawHtml: () => {
          return campaign.champain_raw_html;
        },
        SaveChampainJson: async (jsonStr: string) => {
          try {
            // Validate JSON string
            JSON.parse(jsonStr); // This will throw if invalid JSON
            await Campaign.findByIdAndUpdate(campaignId, {
              champain_json: jsonStr,
            });
            return true;
          } catch (error: any) {
            throw new Error(`Invalid JSON string: ${error.message}`);
          }
        },
      };
    case "fetch_script":
      return {
        fetchCleanCampaignJson: () => {
          try {
            return JSON.parse(campaign.champain_json);
          } catch (error) {
            throw new Error("Failed to parse campaign JSON");
          }
        },
        saveJobsRawHtml: async (jobsData: any) => {
          try {
            // Validate and stringify the jobs data
            const jsonStr = JSON.stringify(jobsData, null, 2);
            await Campaign.findByIdAndUpdate(campaignId, {
              jobs_raw_html: jsonStr,
            });
            return true;
          } catch (error: any) {
            logger.error("Error saving jobs raw HTML:", error);
            throw new Error(`Failed to save jobs raw HTML: ${error.message}`);
          }
        },
        sleep: (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms)),
      };
    case "jobs_cleanup_script":
      return {
        getJobsRawHtml: () => {
          try {
            return JSON.parse(campaign.jobs_raw_html);
          } catch (error) {
            throw new Error("Failed to parse jobs raw HTML");
          }
        },
        saveJobsCleanJson: async (jsonData: any) => {
          try {
            // Validate and stringify the jobs data
            const jsonStr = JSON.stringify(jsonData, null, 2);
            await Campaign.findByIdAndUpdate(campaignId, {
              jobs_clean_json: jsonStr,
            });
            return true;
          } catch (error: any) {
            logger.error("Error saving clean jobs JSON:", error);
            throw new Error(`Failed to save clean jobs JSON: ${error.message}`);
          }
        },
        callAI: async (
          prompt: string,
          config = { provider: "openai", model: undefined }
        ) => {
          const { provider, model } = config;
          switch (provider) {
            case "claude":
              return callClaudeAI(prompt);
            case "ollama":
              return callOllamaAI(prompt, model);
            default:
              return callOpenAI(prompt);
          }
        },
        callAIBatch, // Add the batch processing function
        createBatch: async (request: OpenAIBatchRequest) =>
          createOpenAIBatch(request),
        retrieveBatch: async (batchId: string) => retrieveOpenAIBatch(batchId),
        sleep: (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms)),
      };
    case "email_generation_script":
      return {
        getJobsCleanJson: () => {
          try {
            return JSON.parse(campaign.jobs_clean_json);
          } catch (error) {
            throw new Error("Failed to parse jobs clean JSON");
          }
        },
        saveGeneratedEmails: async (emailsData: any) => {
          try {
            const jsonStr = JSON.stringify(emailsData, null, 2);
            await Campaign.findByIdAndUpdate(campaignId, {
              generated_emails_json: jsonStr,
            });
            return true;
          } catch (error: any) {
            logger.error("Error saving generated emails:", error);
            throw new Error(
              `Failed to save generated emails: ${error.message}`
            );
          }
        },
        callAI: async (
          prompt: string,
          config = { provider: "openai", model: undefined }
        ) => {
          const { provider, model } = config;
          switch (provider) {
            case "claude":
              return callClaudeAI(prompt);
            case "ollama":
              return callOllamaAI(prompt, model);
            default:
              return callOpenAI(prompt);
          }
        },
        callAIBatch, // Add the batch processing function
        createBatch: async (request: OpenAIBatchRequest) =>
          createOpenAIBatch(request),
        retrieveBatch: async (batchId: string) => retrieveOpenAIBatch(batchId),
        sleep: (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms)),
      };
    case "send_emails_script":
      // First verify required environment variables
      if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
        throw new Error("Missing required Mailgun configuration");
      }

      return {
        getGeneratedEmailsJson: () => {
          try {
            return JSON.parse(campaign.generated_emails_json);
          } catch (error) {
            throw new Error("Failed to parse generated emails JSON");
          }
        },
        sendEmail: async (emailData: {
          subject: string;
          to: string;
          bodyHtml: string;
          bodyText: string;
          resumeUrl?: string;
        }) => {
          try {
            const formData: any = {
              from: `David Dodda <hi@${process.env.MAILGUN_DOMAIN}>`,
              to: emailData.to,
              bcc: process.env.BCC_EMAIL,
              subject: emailData.subject,
              text: emailData.bodyText,
              html: emailData.bodyHtml,
            };

            // Add attachment if resumeUrl is provided
            if (emailData.resumeUrl) {
              formData["attachment"] = [
                {
                  filename: "resume.pdf",
                  url: emailData.resumeUrl,
                },
              ];
            }

            const response = await axios.post(
              `https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`,
              formData,
              {
                auth: {
                  username: "api",
                  password: process.env.MAILGUN_API_KEY || "",
                },
                headers: {
                  "Content-Type": "multipart/form-data",
                },
              }
            );

            return {
              success: true,
              messageId: response.data.id,
            };
          } catch (error: any) {
            logger.error("Error sending email:", error);
            throw new Error(`Failed to send email: ${error.message}`);
          }
        },
        sleep: (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms)),
      };
    default:
      return {};
  }
};

export interface ScriptExecutionLog {
  campaignId: string;
  scriptType: string;
  timestamp: Date;
  level: "info" | "error" | "debug";
  message: string;
}

// Add lock management functions
const acquireLock = async (campaignId: string): Promise<boolean> => {
  // Try to set the lock with NX (only if it doesn't exist)
  // EX 300 sets expiration to 5 minutes to prevent deadlocks
  const lockKey = `lock:campaign:${campaignId}`;
  const result = await redisClient.set(lockKey, "locked", {
    NX: true,
    EX: 300, // 5 minutes expiration
  });

  return result === "OK";
};

const releaseLock = async (campaignId: string): Promise<void> => {
  const lockKey = `lock:campaign:${campaignId}`;
  await redisClient.del(lockKey);
};

const isLocked = async (campaignId: string): Promise<boolean> => {
  const lockKey = `lock:campaign:${campaignId}`;
  const lockExists = await redisClient.exists(lockKey);
  return lockExists === 1;
};

// Add this new function to clear old logs
const clearPreviousLogs = async (campaignId: string, scriptType: string) => {
  try {
    // Clear Redis logs
    const logKey = `logs:${campaignId}:${scriptType}`;
    await redisClient.DEL(logKey);

    // Clear MongoDB logs
    const logFieldName = getLogFieldName(scriptType);
    await Campaign.findByIdAndUpdate(campaignId, {
      $set: { [logFieldName]: [] },
    });
  } catch (error) {
    logger.error(`Error clearing previous logs: ${error}`);
  }
};

export const executeScriptInWorker = async (
  campaignId: string,
  scriptType: string,
  scriptContent: string,
  input?: any
) => {
  try {
    // Check if script is running from database
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) {
      throw new Error("Campaign not found");
    }

    if (campaign.is_script_running) {
      throw new Error(
        `Another script (${campaign.current_running_script}) is currently running. Please wait for it to complete.`
      );
    }

    // Set script as running in database
    await Campaign.findByIdAndUpdate(campaignId, {
      is_script_running: true,
      current_running_script: scriptType,
    });

    await clearPreviousLogs(campaignId, scriptType);
    await logScriptExecution(
      campaignId,
      scriptType,
      "info",
      `Starting script execution`
    );

    // Get script-specific functions
    const scriptFunctions = await getScriptFunctions(campaignId, scriptType);

    // Import required libraries
    const libraries: { [key: string]: any } = {};
    if (SCRIPT_LIBRARIES[scriptType]) {
      for (const [key, moduleName] of Object.entries(
        SCRIPT_LIBRARIES[scriptType]
      )) {
        libraries[key] = await import(moduleName as string);
      }
    }

    // Create sandbox with libraries and functions
    const vm = new VM({
      timeout: 30000,
      sandbox: {
        console: {
          log: (message: string) =>
            logScriptExecution(campaignId, scriptType, "info", message),
          error: (message: string) =>
            logScriptExecution(campaignId, scriptType, "error", message),
          debug: (message: string) =>
            logScriptExecution(campaignId, scriptType, "debug", message),
        },
        input,
        axios: axios,
        ...libraries,
        ...scriptFunctions,
      },
    });

    const result = await vm.run(scriptContent);
    await logScriptExecution(
      campaignId,
      scriptType,
      "info",
      `Script execution completed`
    );

    return { success: true, result };
  } catch (error: any) {
    await logScriptExecution(
      campaignId,
      scriptType,
      "error",
      `Script execution failed: ${error.message}`
    );
    throw error;
  } finally {
    // Always reset the script running status
    await Campaign.findByIdAndUpdate(campaignId, {
      is_script_running: false,
      current_running_script: null,
    });
  }
};

// Update the getScriptExecutionStatus function to use database status
export const getScriptExecutionStatus = async (
  campaignId: string
): Promise<{
  isRunning: boolean;
  currentScript?: string;
  lastLog?: ScriptExecutionLog;
}> => {
  try {
    const campaign = await Campaign.findById(campaignId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    // Get all script log arrays
    const allLogs = [
      ...(campaign.cleanup_script_logs || []),
      ...(campaign.fetch_script_logs || []),
      ...(campaign.email_generation_script_logs || []),
      ...(campaign.jobs_cleanup_script_logs || []),
      ...(campaign.send_emails_script_logs || []),
    ];

    // Sort logs by timestamp and get the most recent
    const sortedLogs = allLogs.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const lastLog = sortedLogs[0]
      ? {
          campaignId,
          scriptType: sortedLogs[0].scriptType || "unknown_script",
          timestamp: sortedLogs[0].timestamp,
          level: sortedLogs[0].level,
          message: sortedLogs[0].message,
        }
      : undefined;

    return {
      isRunning: campaign.is_script_running,
      currentScript: campaign.current_running_script,
      lastLog,
    };
  } catch (error) {
    logger.error("Error getting script status:", error);
    return {
      isRunning: false,
    };
  }
};

const getLogFieldName = (scriptType: string): string => {
  switch (scriptType) {
    case "cleanup_script":
      return "cleanup_script_logs";
    case "fetch_script":
      return "fetch_script_logs";
    case "email_generation_script":
      return "email_generation_script_logs";
    case "jobs_cleanup_script":
      return "jobs_cleanup_script_logs";
    case "send_emails_script":
      return "send_emails_script_logs";
    default:
      throw new Error(`Invalid script type: ${scriptType}`);
  }
};

export const logScriptExecution = async (
  campaignId: string,
  scriptType: string,
  level: ScriptExecutionLog["level"],
  message: string
) => {
  const timestamp = new Date();

  // Create log entry
  const log: ScriptExecutionLog = {
    campaignId,
    scriptType,
    timestamp,
    level,
    message,
  };

  try {
    // Save to Redis for real-time access
    const logKey = `logs:${campaignId}:${scriptType}`;
    await redisClient.LPUSH(logKey, JSON.stringify(log));
    await redisClient.LTRIM(logKey, 0, 999);

    // Save to MongoDB for persistence
    const logFieldName = getLogFieldName(scriptType);
    const mongoLog: ScriptLog = { timestamp, level, message };

    await Campaign.findByIdAndUpdate(
      campaignId,
      {
        $push: {
          [logFieldName]: {
            $each: [mongoLog],
            $slice: -1000, // Keep last 1000 logs
          },
        },
      },
      { new: true }
    );
  } catch (error) {
    logger.error(`Error saving log: ${error}`);
  }
};

export const getScriptLogs = async (
  campaignId: string,
  scriptType: string,
  limit = 100
): Promise<ScriptExecutionLog[]> => {
  try {
    // Get logs from MongoDB
    const campaign: any = await Campaign.findById(campaignId);
    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const logFieldName = getLogFieldName(scriptType);
    const logs = campaign[logFieldName] || [];

    // Convert MongoDB logs to ScriptExecutionLog format
    return logs.slice(-limit).map((log: any) => ({
      campaignId,
      scriptType,
      timestamp: log.timestamp,
      level: log.level,
      message: log.message,
    }));
  } catch (error) {
    logger.error(`Error fetching logs: ${error}`);

    // Fallback to Redis if MongoDB fetch fails
    const logKey = `logs:${campaignId}:${scriptType}`;
    const redisLogs = await redisClient.LRANGE(logKey, 0, limit - 1);
    return redisLogs.map((log) => JSON.parse(log));
  }
};
