import crypto from 'crypto';
import type {
  IPaymentProvider,
  PaymentOrderRequest,
  PaymentRefundRequest,
  PaymentLinkRequest,
} from '../../interfaces/payment-provider.interface.js';

// Mock provider intentionally omits fetchPayment/capturePayment. PaymentsService
// treats those as optional — when absent it skips the Razorpay capture round-trip
// and trusts the (always-true) signature check, which is what local mock flows want.
export class MockPaymentProvider implements IPaymentProvider {
  async createOrder(params: PaymentOrderRequest) {
    const orderId = `order_mock_${crypto.randomUUID().slice(0, 8)}`;
    return {
      orderId,
      orderData: {
        id: orderId,
        amount: params.amountPaise,
        currency: params.currency,
        status: 'created',
      },
      keyId: 'rzp_test_mock',
    };
  }

  verifySignature() {
    return true;
  }

  async createPaymentLink(params: PaymentLinkRequest) {
    const id = `plink_mock_${crypto.randomUUID().slice(0, 8)}`;
    // A real-looking short_url so the host UI / QR renders in local dev. The
    // link isn't payable; simulate completion by POSTing a payment_link.paid
    // webhook fixture to /api/payments/webhook.
    return {
      id,
      shortUrl: `https://rzp.io/i/${id}`,
      raw: { id, amount: params.amountPaise, currency: params.currency, status: 'created' },
    };
  }

  async refundPayment(params: PaymentRefundRequest) {
    const refundId = `refund_mock_${crypto.randomUUID().slice(0, 8)}`;
    return {
      refundId,
      refundData: {
        id: refundId,
        payment_id: params.paymentId,
        amount: params.amountPaise,
        status: 'processed',
      },
    };
  }
}

export const mockPaymentProvider = new MockPaymentProvider();
