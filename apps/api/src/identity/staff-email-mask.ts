export function maskEmailForStaffView(email: string): string {
  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator === email.length - 1) return '[REDACTED_EMAIL]';

  const mailbox = email.slice(0, separator);
  const domainLabels = email.slice(separator + 1).split('.');
  if (domainLabels.length < 2 || domainLabels.some((label) => label.length === 0)) {
    return '[REDACTED_EMAIL]';
  }

  const maskedDomain = domainLabels
    .map((label, index) =>
      index === domainLabels.length - 1 ? label : `${[...label][0] ?? ''}***`,
    )
    .join('.');
  return `${[...mailbox][0] ?? ''}***@${maskedDomain}`;
}
