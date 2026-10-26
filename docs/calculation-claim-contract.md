# Calculation claims from agent narrative

This producer candidate keeps every accepted `conclusion` character verbatim, including leading/trailing whitespace. A whitespace-only conclusion is invalid. There is no generated conclusion template or automatic copying of an old calculation.

The native company result tool adds one optional scalar: `calculationClaimQuote: string | null`. For a computed amount in the conclusion, quote its exact decimal amount plus currency span. Otherwise write qualitative narrative. Omission/null does not manufacture a claim. A quote without an explicit calculation is a correctable 422.

The host constructs the optional internal `calculationClaim` object:

```json
{"quote":"-8 000.00 руб.","value":"-8000","unit":"RUB","period":"2027"}
```

The quote must occur exactly once in the unchanged conclusion and bind one complete numeric+currency token. Supported syntax: an optional ASCII sign, decimal digits, optional grouped spaces/NBSP/narrow NBSP in groups of three, optional dot fractional part, followed by a three-uppercase-letter currency or RUB aliases `₽`/`руб.`. Commas, exponent/scaled/worded money are unsupported. Sentence punctuation may follow a quote; partial word/number matches are invalid. Canonicalization uses strings only, without arithmetic or floating point. The period comes from that same explicit calculation; the host never copies history or replaces a quoted 800 with a computed 8000.

InsightService independently computes and verifies the claim against the result/unit/period and checks the remaining narrative under its explicit lexical policy. This producer does not claim universal natural-language numeric validation. Legacy revision/receipt reads accept omitted/null claims.

Only the agreed `CONCLUSION_CLAIM_REQUIRED`, `CONCLUSION_CLAIM_WITHOUT_CALCULATION`, `CONCLUSION_CLAIM_INVALID_QUOTE`, `CONCLUSION_CLAIM_VALUE_MISMATCH`, `CONCLUSION_CLAIM_UNIT_MISMATCH`, `CONCLUSION_CLAIM_PERIOD_MISMATCH`, and `CONCLUSION_UNBOUND_NUMBER` codes cross into model feedback. Their upstream title/message suffixes are replaced with fixed safe guidance. Schema validation and the existing one-correction submission bound remain in place.

The LLM receives no four-field claim input schema. The exact existing synthetic correction fixture additionally requires at least 1024 bytes of headroom under its temporary 65536-byte guard. Oversized mandatory evidence remains fail-closed without truncation or a raised limit.
