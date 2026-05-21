/**
 * money.type.ts
 *
 * WHY: Money is not a number. IEEE 754 floating-point cannot represent
 * most decimal fractions exactly — 0.1 + 0.2 ≠ 0.3. For financial values
 * this is a data integrity defect. We use decimal.js for exact arithmetic
 * and represent amounts as strings on the wire. (ADR-004 §3.3, NFR-REL-010)
 *
 * Rules enforced here:
 *   - Amount always stored as Decimal, never primitive number
 *   - Wire format: string with exactly 4 decimal places ("1250.0000")
 *   - Currency always ISO-4217 (3 uppercase chars)
 *   - HALF_UP rounding on any arithmetic result
 */

import Decimal from 'decimal.js';

// Configure Decimal.js globally for this service.
// HALF_UP matches accounting conventions.
Decimal.set({ rounding: Decimal.ROUND_HALF_UP, toExpPos: 20 });

export interface MoneyDto {
  /** Decimal string with exactly 4 decimal places. e.g. "1250.0000" */
  amount: string;
  /** ISO-4217 currency code. e.g. "INR" */
  currency: string;
}

export class Money {
  public readonly amount: Decimal;
  public readonly currency: string;

  private constructor(amount: Decimal, currency: string) {
    this.amount = amount;
    this.currency = currency.toUpperCase();
  }

  /** Parse from the wire format (string amount). Throws on invalid input. */
  static fromDto(dto: MoneyDto): Money {
    if (!/^\d+\.\d{4}$/.test(dto.amount)) {
      throw new Error(
        `Invalid money amount format: "${dto.amount}". ` +
          `Expected decimal string with exactly 4 places (e.g. "1250.0000").`,
      );
    }
    if (!/^[A-Z]{3}$/.test(dto.currency.toUpperCase())) {
      throw new Error(
        `Invalid currency code: "${dto.currency}". Expected ISO-4217 (3 uppercase letters).`,
      );
    }
    return new Money(new Decimal(dto.amount), dto.currency);
  }

  /** Serialise to wire format for API responses and Kafka messages. */
  toDto(): MoneyDto {
    return {
      // toFixed(4) gives exactly 4 decimal places; HALF_UP rounding already set globally.
      amount: this.amount.toFixed(4),
      currency: this.currency,
    };
  }

  /** Compare currencies before any arithmetic — mixing currencies is always a bug. */
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: cannot operate on ${this.currency} and ${other.currency}.`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.greaterThan(other.amount);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }
}
