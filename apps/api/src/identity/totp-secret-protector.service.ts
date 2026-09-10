import { Inject, Injectable } from '@nestjs/common';
import { MFA_DATA_PROTECTION_KEYS } from './identity.constants';
import { TotpSecretCipher, type TotpSecretProtectionKeys } from './totp-secret-cipher';

export { MfaSecretProtectionError } from './totp-secret-cipher';

@Injectable()
export class TotpSecretProtector extends TotpSecretCipher {
  constructor(@Inject(MFA_DATA_PROTECTION_KEYS) keys: TotpSecretProtectionKeys) {
    super(keys);
  }
}
