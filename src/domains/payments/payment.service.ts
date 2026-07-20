import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceResult, UUID } from "@/types/domain";

export interface PaymentOrderResult {
  orderId: string;
  amount: number;
  amountPaise: number;
  currency: "INR" | "USD";
  keyId: string;
  bookingId: UUID;
  paymentId?: UUID;
  status?: string;
}

export class PaymentService {
  async createOrder(params: {
    bookingId: UUID;
    amount: number;
    currency: "INR" | "USD";
    insuranceOptIn: boolean;
    idempotencyKey?: string;
  }): Promise<ServiceResult<PaymentOrderResult>> {
    const result = await apiRequest<PaymentOrderResult>("/api/payments/create-order", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify(params),
    });

    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: result.data };
  }

  async verifyPayment(params: {
    bookingId: UUID;
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
    idempotencyKey?: string;
  }): Promise<ServiceResult<{ success: boolean; message: string; paymentId?: UUID; pending?: boolean }>> {
    const result = await apiRequest<{ success: boolean; message: string; paymentId?: UUID; pending?: boolean }>("/api/payments/verify", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify(params),
    });

    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: result.data };
  }
}

let _instance: PaymentService | null = null;
export function getPaymentService(): PaymentService {
  if (!_instance) _instance = new PaymentService();
  return _instance;
}
