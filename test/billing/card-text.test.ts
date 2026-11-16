import { describe, it, expect } from 'vitest';
import { CARD_DETAILS, CARD_LAST4 } from '../helpers/card-text';

describe('the test card as a token of its own', () => {
  it('finds the card wherever it is shown', () => {
    for (const shown of ['{"last4":"4242"}', '{"last4":4242}', 'ending in 4242', '•••• 4242', 'last4=4242', '"4242"']) expect(shown, shown).toMatch(CARD_LAST4);
    expect('Visa card').toMatch(CARD_DETAILS);
  });
  it('does not find it inside a random id: 189 of 200,000 workspace ids contain "4242" and they are not the card', () => {
    for (const id of ['ws_4242abcdef', 'ws_ab4242cd', 'ws_abcdef4242', 'ord-4242a', 'order_a4242-9']) { expect(id, id).not.toMatch(CARD_LAST4); expect(id, id).not.toMatch(CARD_DETAILS); }
    const hex = (n: number) => Array.from({ length: n }, (_, i) => ((i * 7 + 4) % 16).toString(16)).join('');
    expect(`ws_${hex(3)}4242${hex(5)}`).not.toMatch(CARD_DETAILS);
  });
});
