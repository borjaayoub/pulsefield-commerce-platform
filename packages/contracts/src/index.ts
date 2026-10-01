export type ActorType = 'customer' | 'staff' | 'system';
export * from './realtime';

export interface CommerceModuleDefinition {
  key: string;
  version: number;
  dependencies: string[];
  permissions: string[];
  publishedEvents: string[];
  consumedEvents: string[];
}

export interface CommandContext {
  idempotencyKey: string;
  requestId: string;
  correlationId: string;
  causationId?: string;
  actor: {
    type: ActorType;
    id: string;
    roles: string[];
  };
}

export type SupportedCurrency = 'MAD' | 'EUR' | 'USD' | 'GBP';

export interface Money {
  amountMinor: bigint;
  currency: SupportedCurrency;
}

export interface DomainEventEnvelope<TPayload> {
  id: string;
  type: string;
  version: number;
  aggregateId: string;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  payload: TPayload;
}

export interface CreatePaymentInput {
  orderId: string;
  amount: Money;
  paymentMethodReference?: string;
  providerPaymentId?: string;
  metadata: {
    paymentAttemptId: string;
    orderReference: string;
  };
}

export interface PaymentResult {
  paymentId: string;
  status: 'requires_payment_method' | 'processing' | 'succeeded' | 'failed';
  clientSecret?: string;
}

export interface RetrievePaymentInput {
  orderId: string;
  paymentId: string;
  paymentMethodReference?: string;
  amount: Money;
  metadata: {
    paymentAttemptId: string;
    orderReference: string;
  };
}

export interface PaymentEvent {
  id: string;
  type: string;
  paymentId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface RefundInput {
  paymentId: string;
  amount: Money;
  reason: string;
}

export interface RefundResult {
  refundId: string;
  status: 'processing' | 'succeeded' | 'failed';
}

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput, context: CommandContext): Promise<PaymentResult>;
  retrievePayment(input: RetrievePaymentInput): Promise<PaymentResult>;
  verifyWebhook(payload: unknown, signature: string): Promise<PaymentEvent>;
  cancel(paymentId: string, context: CommandContext): Promise<void>;
  refund(input: RefundInput, context: CommandContext): Promise<RefundResult>;
}

export interface TaxCalculationInput {
  destinationCountry: string;
  subtotal: Money;
}

export interface TaxCalculation {
  amount: Money;
  calculationId: string;
}

export interface TaxProvider {
  calculate(input: TaxCalculationInput): Promise<TaxCalculation>;
}

export interface ShippingQuoteInput {
  destinationCountry: string;
  weightGrams: number;
  currency: SupportedCurrency;
}

export interface ShippingOption {
  id: string;
  label: string;
  amount: Money;
}

export interface ShippingProvider {
  getOptions(input: ShippingQuoteInput): Promise<ShippingOption[]>;
}

export interface ReservationInput {
  variantQuantities: Array<{ variantId: string; quantity: number }>;
  destinationCountry: string;
}

export interface AllocationResult {
  reservationId: string;
  expiresAt: string;
  allocations: Array<{ warehouseId: string; variantId: string; quantity: number }>;
}

export interface InventoryAllocator {
  reserve(input: ReservationInput, context: CommandContext): Promise<AllocationResult>;
  release(reservationId: string, context: CommandContext): Promise<void>;
  commit(reservationId: string, context: CommandContext): Promise<void>;
}

export interface NotificationMessage {
  recipient: string;
  template: string;
  locale: string;
  data: Record<string, unknown>;
}

export interface DeliveryResult {
  providerMessageId: string;
  status: 'accepted' | 'failed';
}

export interface NotificationProvider {
  send(message: NotificationMessage): Promise<DeliveryResult>;
}

export const IDENTITY_NOTIFICATION_QUEUE = 'identity-notifications';
export const IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE = 'identity-notifications-dead-letter';
export const NOTIFICATION_DELIVERY_OUTCOME_QUEUE = 'notification-delivery-outcomes';
export const SEND_EMAIL_VERIFICATION_JOB = 'send-email-verification.v1';
export const SEND_PASSWORD_RECOVERY_JOB = 'send-password-recovery.v1';
export const SEND_ORDER_CONFIRMATION_JOB = 'send-order-confirmation.v1';
export const NOTIFICATION_DEAD_LETTER_JOB = 'notification-dead-letter.v1';
export const NOTIFICATION_DELIVERY_OUTCOME_JOB = 'notification-delivery-outcome.v1';
export const PAYMENT_WEBHOOK_INBOX_QUEUE = 'payment-webhook-inbox';
export const PROCESS_PAYMENT_WEBHOOK_JOB = 'process-payment-webhook.v1';

export interface PaymentWebhookInboxJobData {
  version: 1;
  inboxId: string;
}

export interface EncryptedMessageEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  initializationVector: string;
  authenticationTag: string;
  ciphertext: string;
}

export interface EmailVerificationDeliveryPayload {
  version: 1;
  recipient: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface EmailVerificationJobData {
  version: 1;
  sourceEventId: string;
  correlationId: string;
  userId: string;
  encryptedDelivery: EncryptedMessageEnvelope;
}

export interface PasswordRecoveryDeliveryPayload {
  version: 1;
  recipient: string;
  passwordResetUrl: string;
  expiresAt: string;
}

export interface PasswordRecoveryJobData {
  version: 1;
  sourceEventId: string;
  correlationId: string;
  userId: string;
  encryptedDelivery: EncryptedMessageEnvelope;
}

export interface OrderConfirmationDeliveryPayload {
  version: 1;
  recipient: string;
  orderReference: string;
  orderTimelineUrl: string;
  accessExpiresAt: string;
}

export interface OrderConfirmationJobData {
  version: 1;
  sourceEventId: string;
  correlationId: string;
  orderId: string;
  encryptedDelivery: EncryptedMessageEnvelope;
}

export type IdentityNotificationJobData =
  EmailVerificationJobData | PasswordRecoveryJobData | OrderConfirmationJobData;

export interface NotificationDeadLetterJobData {
  version: 1;
  sourceEventId: string;
  sourceJobId: string;
  sourceJobName: string;
  failedAt: string;
  attemptsMade: number;
  errorCode: 'NOTIFICATION_PROCESSING_FAILED';
}

export interface NotificationDeliveryAcceptedOutcome {
  version: 1;
  sourceEventId: string;
  status: 'accepted';
  workerAttemptCount: number;
}

export interface NotificationDeliveryTerminalFailureOutcome {
  version: 1;
  sourceEventId: string;
  status: 'failed-terminal';
  workerAttemptCount: number;
  failureCode: 'NOTIFICATION_PROCESSING_FAILED';
}

export type NotificationDeliveryOutcomeJobData =
  NotificationDeliveryAcceptedOutcome | NotificationDeliveryTerminalFailureOutcome;

export interface MetricQuery {
  from: string;
  to: string;
  currency?: SupportedCurrency;
}

export interface MetricResult {
  key: string;
  value: number;
  source: 'commerce_projection' | 'behavioral_event';
}

export interface AnalyticsMetric {
  key: string;
  calculate(input: MetricQuery): Promise<MetricResult>;
}
