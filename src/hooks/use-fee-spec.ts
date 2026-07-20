/**
 * Server-resolved platform-fee spec for a listing (admin fee-rules panel:
 * listing > city > tier > state > global). Fetched ONCE per listing — the
 * spec is subtotal-independent; the modal applies it locally with
 * computePlatformFeePaise as the subtotal changes.
 *
 * Fallback contract: on any error (offline, old server) this returns
 * LEGACY_PLATFORM_FEE_SPEC — the same fallback the server itself uses when
 * rule resolution fails, so preview and charge degrade to the same flat ₹3.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { LEGACY_PLATFORM_FEE_SPEC, type PlatformFeeSpec } from "@/lib/pricing";

interface FeeQuoteResponse {
  platformFeePaise: number;
  subtotalPaise: number;
  spec: PlatformFeeSpec;
  vertical: string;
}

export function useFeeSpec(listingId: string | null | undefined): PlatformFeeSpec {
  const { data } = useQuery({
    queryKey: ["fee-spec", listingId],
    enabled: Boolean(listingId),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const res = await apiRequest<FeeQuoteResponse>(
        `/api/listings/${listingId}/fee-quote?subtotalPaise=0`
      );
      if (!res.success || !res.data?.spec) {
        throw new Error(res.error || "fee quote failed");
      }
      return res.data.spec;
    },
  });
  return data ?? LEGACY_PLATFORM_FEE_SPEC;
}
