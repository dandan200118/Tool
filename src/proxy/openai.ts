import { Request, RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { AzureOpenAIKey, keyPool, OpenAIKey } from "../shared/key-management";
import { getOpenAIModelFamily } from "../shared/models";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  addKeyForEmbeddingsRequest,
  createEmbeddingsPreprocessorMiddleware,
  createOnProxyReqHandler,
  createPreprocessorMiddleware,
  finalizeBody,
  forceModel,
  RequestPreprocessor,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";
import { getHttpAgents } from "../shared/network";

// https://platform.openai.com/docs/models/overview
let modelsCache: any = null;
let modelsCacheTime = 0;

export function generateModelList(service: "openai" | "azure") {
  const keys = keyPool
    .list()
    .filter((k) => k.service === service && !k.isDisabled) as
    | OpenAIKey[]
    | AzureOpenAIKey[];
  if (keys.length === 0) return [];

  const allowedModelFamilies = new Set(config.allowedModelFamilies);
  const modelFamilies = new Set(
    keys
      .flatMap((k) => k.modelFamilies)
      .filter((f) => allowedModelFamilies.has(f))
  );

  const modelIds = new Set(
    keys
      .flatMap((k) => k.modelIds)
      .filter((id) => {
        const allowed = modelFamilies.has(getOpenAIModelFamily(id));
        const known = ["gpt", "o1", "dall-e", "text-embedding-ada-002"].some(
          (prefix) => id.startsWith(prefix)
        );
        const isFinetune = id.includes("ft");
        return allowed && known && !isFinetune;
      })
  );

  return Array.from(modelIds).map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: service,
    permission: [
      {
        id: "modelperm-" + id,
        object: "model_permission",
        created: new Date().getTime(),
        organization: "*",
        group: null,
        is_blocking: false,
      },
    ],
    root: id,
    parent: null,
  }));
}

const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return res.status(200).json(modelsCache);
  }

  if (!config.openaiKey) return { object: "list", data: [] };

  const result = generateModelList("openai");

  modelsCache = { object: "list", data: result };
  modelsCacheTime = new Date().getTime();
  res.status(200).json(modelsCache);
};

/** Handles some turbo-instruct special cases. */
const rewriteForTurboInstruct: RequestPreprocessor = (req) => {
  // /v1/turbo-instruct/v1/chat/completions accepts either prompt or messages.
  // Depending on whichever is provided, we need to set the inbound format so
  // it is transformed correctly later.
  if (req.body.prompt && !req.body.messages) {
    req.inboundApi = "openai-text";
  } else if (req.body.messages && !req.body.prompt) {
    req.inboundApi = "openai";
    // Set model for user since they're using a client which is not aware of
    // turbo-instruct.
    req.body.model = "gpt-3.5-turbo-instruct";
  } else {
    throw new Error("`prompt` OR `messages` must be provided");
  }

  req.url = "/v1/completions";
};

const openaiResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  if (req.outboundApi === "openai-text" && req.inboundApi === "openai") {
    req.log.info("Transforming Turbo-Instruct response to Chat format");
    newBody = transformTurboInstructResponse(body);
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

/** Only used for non-streaming responses. */
function transformTurboInstructResponse(
  turboInstructBody: Record<string, any>
): Record<string, any> {
  const transformed = { ...turboInstructBody };
  transformed.choices = [
    {
      ...turboInstructBody.choices[0],
      message: {
        role: "assistant",
        content: turboInstructBody.choices[0].text.trim(),
      },
    },
  ];
  delete transformed.choices[0].text;
  return transformed;
}

const openaiProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.openai.com",
    agent: getHttpAgents()[0],
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({ pipeline: [addKey, finalizeBody] }),
      proxyRes: createOnProxyResHandler([openaiResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const openaiEmbeddingsProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  agent: getHttpAgents()[0],
  changeOrigin: true,
  selfHandleResponse: false,
  logger,
  on: {
    proxyReq: createOnProxyReqHandler({
      pipeline: [addKeyForEmbeddingsRequest, finalizeBody],
    }),
    error: handleProxyError,
  },
});

const openaiRouter = Router();
openaiRouter.get("/v1/models", handleModelRequest);
// Native text completion endpoint, only for turbo-instruct.
openaiRouter.post(
  "/v1/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-text",
    outApi: "openai-text",
    service: "openai",
  }),
  openaiProxy
);
// turbo-instruct compatibility endpoint, accepts either prompt or messages
openaiRouter.post(
  /\/v1\/turbo-instruct\/(v1\/)?chat\/completions/,
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai-text", service: "openai" },
    {
      beforeTransform: [rewriteForTurboInstruct],
      afterTransform: [forceModel("gpt-3.5-turbo-instruct")],
    }
  ),
  openaiProxy
);
// General chat completion endpoint. Turbo-instruct is not supported here.
openaiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openai" },
    { afterTransform: [fixupMaxTokens] }
  ),
  openaiProxy
);
// Embeddings endpoint.
openaiRouter.post(
  "/v1/embeddings",
  ipLimiter,
  createEmbeddingsPreprocessorMiddleware(),
  openaiEmbeddingsProxy
);

function fixupMaxTokens(req: Request) {
  if (!req.body.max_completion_tokens) {
    req.body.max_completion_tokens = req.body.max_tokens;
  }
  delete req.body.max_tokens;
}

export const openai = openaiRouter;
