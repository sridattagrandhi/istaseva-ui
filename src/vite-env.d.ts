/// <reference types="vite/client" />

interface RazorpayCheckoutResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  handler: (response: RazorpayCheckoutResponse) => void | Promise<void>;
  modal?: {
    ondismiss?: () => void;
  };
  prefill?: {
    email?: string;
    contact?: string;
    name?: string;
  };
  notes?: Record<string, string>;
  theme?: {
    color?: string;
  };
}

interface Window {
  Razorpay?: new (options: RazorpayCheckoutOptions) => {
    open: () => void;
    on: (event: string, handler: (payload: unknown) => void) => void;
  };
}
