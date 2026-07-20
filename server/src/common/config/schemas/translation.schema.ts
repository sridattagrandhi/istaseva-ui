import { z } from 'zod';

export const translationSchema = z.object({
  // `none` = passthrough (returns source text unchanged, useful for dev and
  // when the upstream API is unreachable). `bhashini` = call the Indian
  // government's Bhashini ULCA pipeline.
  provider: z.enum(['bhashini', 'none']).default('none'),
  bhashiniUserId: z.string().optional(),
  bhashiniApiKey: z.string().optional(),
  bhashiniUdyatKey: z.string().optional(),
  bhashiniPipelineEndpoint: z
    .string()
    .default('https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline'),
  // PipelineId for the translation task — Meity ULCA publishes one canonical
  // id for the NMT pipeline. Overridable for staging/tests.
  bhashiniPipelineId: z
    .string()
    .default('64392f96daac500b55c543cd'),
});
