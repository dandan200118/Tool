import { Transform, TransformOptions } from "stream";
import { logger } from "../../../../logger";
import { countTokens } from "../../../../shared/tokenization";
import {
  eventIsOpenAIEvent,
  eventIsAnthropicV2Event,
} from "./index";
import { APIFormat, Key, keyPool } from "../../../../shared/key-management";
import { User } from "../../../../shared/users/schema";
import { incrementPromptCount, incrementTokenCount } from "../../../../shared/users/user-store";

type CounterOptions = TransformOptions & {
  key: Key;
  inboundApi: APIFormat;
  requestedModel: string;
  logger: typeof logger;
  user?: User;
  inputTokens: number;
}

/**
 * Counts tokens from each event and increments quota usage.
 * This ensures that all tokens are counted, even if the streaming request
 * is aborted by the client halfway through.
 */
export class Counter extends Transform {
  private didRecordInputTokens = false;
  private didIncrementPromptCount = false;
  private readonly key: Key;
  private readonly inboundApi: APIFormat;
  private readonly log;
  private readonly model: string;
  private readonly user?: User;
  private readonly inputTokens: number;

  constructor(options: CounterOptions) {
    super({ ...options, objectMode: true });
    this.key = options.key;
    this.inboundApi = options.inboundApi;
    this.log = options.logger?.child({ module: "counter" });
    this.model = options.requestedModel;
    this.user = options.user;
    this.inputTokens = options.inputTokens;
  }

  _transform(event: any, _encoding: BufferEncoding, callback: Function) {
    (async () => {
      try {
        let tokens = 0;
        let completion = undefined;;
        if (eventIsOpenAIEvent(event)) {
          completion = event.choices?.[0]?.delta?.content;
        } else if (eventIsAnthropicV2Event(event)) {
          completion = event.completion;
        }
        if (completion !== undefined) {
          tokens = (await countTokens({
            // This is okay because image requests are never streaming,
            // and the only thing read from the request is the model.
            req: ({ body: { model: this.model } } as any),
            service: this.inboundApi,
            completion,
          })).token_count;
        }
        this.log.debug(
          { inboundApi: this.inboundApi, tokens },
          "Counted tokens for streaming delta"
        );

        // If we didn't record input tokens, do that now
        if (!this.didRecordInputTokens) {
          tokens += this.inputTokens;
          this.didRecordInputTokens = true;
        }

        if (tokens > 0) {
          // Record quota
          keyPool.incrementUsage(this.key, this.model, tokens);
          if (this.user) {
            if (!this.didIncrementPromptCount) {
              incrementPromptCount(this.user.token);
              this.didIncrementPromptCount = true;
            }
            incrementTokenCount(this.user.token, this.model, this.inboundApi, tokens);
          }
        }
        this.push(event);
        callback();
      } catch (err) {
        err.lastEvent = event;
        this.log.error(err, "Error counting tokens and increasing quota usage");
        callback(err);
      }
    })();
  }
}
