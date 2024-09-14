import { Request, RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { v4 } from "uuid";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  createPreprocessorMiddleware,
  signAwsRequest,
  finalizeSignedRequest,
  createOnProxyReqHandler,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";
import {
  transformAnthropicChatResponseToAnthropicText,
  transformAnthropicChatResponseToOpenAI,
} from "./anthropic";
import { getHttpAgents } from "../shared/network";

/** Only used for non-streaming requests. */
const awsResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  switch (`${req.inboundApi}<-${req.outboundApi}`) {
    case "openai<-anthropic-text":
      req.log.info("Transforming Anthropic Text back to OpenAI format");
      newBody = transformAwsTextResponseToOpenAI(body, req);
      break;
    case "openai<-anthropic-chat":
      req.log.info("Transforming AWS Anthropic Chat back to OpenAI format");
      newBody = transformAnthropicChatResponseToOpenAI(body);
      break;
    case "anthropic-text<-anthropic-chat":
      req.log.info("Transforming AWS Anthropic Chat back to Text format");
      newBody = transformAnthropicChatResponseToAnthropicText(body);
      break;
  }

  // AWS does not always confirm the model in the response, so we have to add it
  if (!newBody.model && req.body.model) {
    newBody.model = req.body.model;
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAwsTextResponseToOpenAI(
  awsBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "aws-" + v4(),
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: awsBody.completion?.trim(),
        },
        finish_reason: awsBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const awsClaudeProxy = createQueueMiddleware({
  beforeProxy: signAwsRequest,
  proxyMiddleware: createProxyMiddleware({
    target: "bad-target-will-be-rewritten",
    agent: getHttpAgents()[0],
    router: ({ signedRequest }) => {
      if (!signedRequest) throw new Error("Must sign request before proxying");
      return `${signedRequest.protocol}//${signedRequest.hostname}`;
    },
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({ pipeline: [finalizeSignedRequest] }),
      proxyRes: createOnProxyResHandler([awsResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const nativeTextPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-text", outApi: "anthropic-text", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

const textToChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-text", outApi: "anthropic-chat", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

/**
 * Routes text completion prompts to aws anthropic-chat if they need translation
 * (claude-3 based models do not support the old text completion endpoint).
 */
const preprocessAwsTextRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.includes("claude-3")) {
    textToChatPreprocessor(req, res, next);
  } else {
    nativeTextPreprocessor(req, res, next);
  }
};

const oaiToAwsTextPreprocessor = createPreprocessorMiddleware(
  { inApi: "openai", outApi: "anthropic-text", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

const oaiToAwsChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "openai", outApi: "anthropic-chat", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

/**
 * Routes an OpenAI prompt to either the legacy Claude text completion endpoint
 * or the new Claude chat completion endpoint, based on the requested model.
 */
const preprocessOpenAICompatRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.includes("claude-3")) {
    oaiToAwsChatPreprocessor(req, res, next);
  } else {
    oaiToAwsTextPreprocessor(req, res, next);
  }
};

const awsClaudeRouter = Router();
// Native(ish) Anthropic text completion endpoint.
awsClaudeRouter.post(
  "/v1/complete",
  ipLimiter,
  preprocessAwsTextRequest,
  awsClaudeProxy
);
// Native Anthropic chat completion endpoint.
awsClaudeRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "anthropic-chat", outApi: "anthropic-chat", service: "aws" },
    { afterTransform: [maybeReassignModel] }
  ),
  awsClaudeProxy
);

// OpenAI-to-AWS Anthropic compatibility endpoint.
awsClaudeRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  preprocessOpenAICompatRequest,
  awsClaudeProxy
);

/**
 * Tries to deal with:
 * - frontends sending AWS model names even when they want to use the OpenAI-
 *   compatible endpoint
 * - frontends sending Anthropic model names that AWS doesn't recognize
 * - frontends sending OpenAI model names because they expect the proxy to
 *   translate them
 *
 * If client sends AWS model ID it will be used verbatim. Otherwise, various
 * strategies are used to try to map a non-AWS model name to AWS model ID.
 */
function maybeReassignModel(req: Request) {
  const model = req.body.model;

  // If it looks like an AWS model, use it as-is
  if (model.includes("anthropic.claude")) {
    return;
  }

  // Anthropic model names can look like:
  // - claude-v1
  // - claude-2.1
  // - claude-3-5-sonnet-20240620-v1:0
  const pattern =
    /^(claude-)?(instant-)?(v)?(\d+)([.-](\d))?(-\d+k)?(-sonnet-|-opus-|-haiku-)?(\d*)/i;
  const match = model.match(pattern);

  // If there's no match, fallback to Claude v2 as it is most likely to be
  // available on AWS.
  if (!match) {
    req.body.model = `anthropic.claude-v2:1`;
    return;
  }

  const [_, _cl, instant, _v, major, _sep, minor, _ctx, name, _rev] = match;

  if (instant) {
    req.body.model = "anthropic.claude-instant-v1";
    return;
  }

  const ver = minor ? `${major}.${minor}` : major;
  switch (ver) {
    case "1":
    case "1.0":
      req.body.model = "anthropic.claude-v1";
      return;
    case "2":
    case "2.0":
      req.body.model = "anthropic.claude-v2";
      return;
    case "3":
    case "3.0":
      if (name.includes("opus")) {
        req.body.model = "anthropic.claude-3-opus-20240229-v1:0";
      } else if (name.includes("haiku")) {
        req.body.model = "anthropic.claude-3-haiku-20240307-v1:0";
      } else {
        req.body.model = "anthropic.claude-3-sonnet-20240229-v1:0";
      }
      return;
    case "3.5":
      req.body.model = "anthropic.claude-3-5-sonnet-20240620-v1:0";
      return;
  }

  // Fallback to Claude 2.1
  req.body.model = `anthropic.claude-v2:1`;
  return;
}

export const awsClaude = awsClaudeRouter;
