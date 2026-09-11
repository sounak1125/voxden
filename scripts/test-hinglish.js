'use strict';

// Devanagari to Hinglish: the spellings people type, on sentences the
// engines actually produced for a Hindi-English speaker.

const assert = require('assert');
const { romanizeHindi, hasDevanagari } = require('../src/hinglish');

let checks = 0;
function eq(input, expected) {
  const actual = romanizeHindi(input);
  assert.strictEqual(actual, expected, input + '\n  got:      ' + actual + '\n  expected: ' + expected);
  checks += 1;
  process.stdout.write('ok ' + input + ' -> ' + actual + '\n');
}

// From the user's own dictations.
eq('आप किधर से हो?', 'aap kidhar se ho?');
eq('ये सब हो गया है', 'ye sab ho gaya hai');
eq('आइए स्रीया ये काम करिए.', 'aaiye sreeya ye kaam kariye.');
eq('okay, आप किधर से हो?', 'okay, aap kidhar se ho?');
eq("It's been Hindi में लिखा तो है, but बहुत गलत है।", "It's been Hindi mein likha toh hai, but bahut galat hai.");
eq('Like, बहुत basic words इसको नहीं आता।', 'Like, bahut basic words isko nahi aata.');

// Schwa deletion: dropped at the end and between voiced syllables, kept
// where the word needs it.
eq('करना', 'karna');
eq('समझ', 'samajh');
eq('किधर', 'kidhar');
eq('कल', 'kal');
eq('चलते', 'chalte');

// Common words spell one way.
eq('मुझे नहीं पता', 'mujhe nahi pata');
eq('हिंदी में लिखो', 'hindi mein likho');
eq('मैं कल आऊंगा', 'main kal aaunga');
eq('यह ३ बजे होगा', 'yeh 3 baje hoga');
eq('बहुत अच्छा', 'bahut accha');
eq('क्या हाल है भाई', 'kya haal hai bhai');
eq('क्यों नहीं आए', 'kyun nahi aaye');

// Nukta letters, long vowels, nasals.
eq('थोड़ा रुको', 'thoda ruko');
eq('लड़की पढ़ रही है', 'ladki padh rahi hai');
eq('ठीक है', 'theek hai');
eq('पानी पीना है', 'paani peena hai');
eq('चलो चलते हैं', 'chalo chalte hain');
eq('मेरा नाम सौनक है', 'mera naam saunak hai');

// Non-Devanagari text is untouched, byte for byte.
eq('Hello, this is plain English with numbers 123 and émojis 🙂.', 'Hello, this is plain English with numbers 123 and émojis 🙂.');
eq('', '');
assert.strictEqual(hasDevanagari('abc'), false);
assert.strictEqual(hasDevanagari('abc ह'), true);
checks += 2;

process.stdout.write('all ' + checks + ' Hinglish checks passed\n');
