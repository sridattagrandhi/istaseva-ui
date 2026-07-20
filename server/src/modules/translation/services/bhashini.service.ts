import { config } from '../../../common/config/index.js';

/**
 * Bhashini client — calls the Meity ULCA pipeline in a two-step flow:
 *  1. POST to the pipeline-discovery endpoint with the source+target language
 *     pair; the response carries the actual inference URL + a per-request
 *     auth token.
 *  2. POST the batch of sentences to that inference URL.
 *
 * Kept as a pure function (no state) so a failing Bhashini outage doesn't
 * leave the process holding stale auth.
 */
export interface TranslateProvider {
  translateBatch(args: {
    sourceLang: string;
    targetLang: string;
    texts: string[];
  }): Promise<string[]>;
}

interface PipelineResponse {
  pipelineResponseConfig: Array<{
    taskType: string;
    config: Array<{ serviceId: string }>;
  }>;
  pipelineInferenceAPIEndPoint: {
    callbackUrl: string;
    inferenceApiKey: { name: string; value: string };
  };
}

export class BhashiniProvider implements TranslateProvider {
  async translateBatch({ sourceLang, targetLang, texts }: { sourceLang: string; targetLang: string; texts: string[] }): Promise<string[]> {
    if (texts.length === 0) return [];

    const pipeline = await this.resolvePipeline(sourceLang, targetLang);
    const serviceId = pipeline.pipelineResponseConfig
      .find((c) => c.taskType === 'translation')?.config[0]?.serviceId;
    if (!serviceId) throw new Error('Bhashini pipeline did not return a translation service id');

    const { callbackUrl, inferenceApiKey } = pipeline.pipelineInferenceAPIEndPoint;

    const body = {
      pipelineTasks: [
        {
          taskType: 'translation',
          config: {
            language: { sourceLanguage: sourceLang, targetLanguage: targetLang },
            serviceId,
          },
        },
      ],
      inputData: { input: texts.map((source) => ({ source })) },
    };

    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [inferenceApiKey.name]: inferenceApiKey.value,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Bhashini inference failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as {
      pipelineResponse: Array<{ output: Array<{ source: string; target: string }> }>;
    };
    const out = json.pipelineResponse[0]?.output ?? [];
    return texts.map((_, i) => out[i]?.target ?? texts[i]);
  }

  private async resolvePipeline(sourceLang: string, targetLang: string): Promise<PipelineResponse> {
    const { bhashiniPipelineEndpoint, bhashiniPipelineId, bhashiniUserId, bhashiniApiKey, bhashiniUdyatKey } = config.translation;
    const res = await fetch(bhashiniPipelineEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        userID: bhashiniUserId!,
        ulcaApiKey: bhashiniApiKey!,
        'Authorization': bhashiniUdyatKey!,
      },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: 'translation',
            config: { language: { sourceLanguage: sourceLang, targetLanguage: targetLang } },
          },
        ],
        pipelineRequestConfig: { pipelineId: bhashiniPipelineId },
      }),
    });
    if (!res.ok) throw new Error(`Bhashini pipeline discovery failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as PipelineResponse;
  }
}

/** Passthrough provider — returns source text unchanged. Default when no
 *  Bhashini credentials are configured so dev/tests don't hit the network. */
export class PassthroughProvider implements TranslateProvider {
  async translateBatch({ texts }: { sourceLang: string; targetLang: string; texts: string[] }): Promise<string[]> {
    return texts.slice();
  }
}

export function createTranslateProvider(): TranslateProvider {
  return config.translation.provider === 'bhashini'
    ? new BhashiniProvider()
    : new PassthroughProvider();
}
