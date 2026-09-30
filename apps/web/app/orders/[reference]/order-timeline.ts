export type OrderTimeline = {
  orderReference: string;
  status: string;
  fulfillmentProgress: string;
  currency: 'USD';
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  lines: Array<{
    productName: string;
    variantName: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>;
  events: Array<{ type: string; occurredAt: string; label: string }>;
  shipments: Array<{
    ordinal: number;
    total: number;
    status: string;
    items: Array<{ productName: string; variantName: string; quantity: number }>;
    carrierCode: string | null;
    trackingReference: string | null;
  }>;
  accessExpiresAt: string;
};

export function accessTokenFromFragment(fragment: string): string | undefined {
  const value = new URLSearchParams(fragment.replace(/^#/u, '')).get('access');
  return value && value.length <= 128 ? value : undefined;
}

export function guestOrderSessionKey(reference: string): string {
  return `pulse-field:guest-order:${reference}`;
}
