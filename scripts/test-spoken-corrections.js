'use strict';

// Spoken corrections (src/spoken-corrections.js): what a speaker takes back
// mid-sentence is taken out, and everything that only sounds like a
// correction is left exactly as said. The "kept" half is the important one:
// several of its lines are the shapes of real dictations a looser version
// changed wrongly (2026-10-05).

const assert = require('assert');
const { applySpokenCorrections } = require('../src/spoken-corrections');

const corrected = [
  // The case that asked for the feature, punctuated both ways an engine does.
  ['The cat is running on the field, no, no, in the park.', 'The cat is running in the park.'],
  ['The cat is running on the field. No, no, in the park.', 'The cat is running in the park.'],
  ['The cat is running on the field, uh, no, in the park.', 'The cat is running in the park.'],
  // Numbers, dates and times.
  ["Let's meet at 3, no, 4.", "Let's meet at 4."],
  ["Let's meet at 3, no, 4 tomorrow.", "Let's meet at 4 tomorrow."],
  ['The trip is confirmed for the fourteenth, no wait, the fifteenth.', 'The trip is confirmed for the fifteenth.'],
  ["We'll launch on the 5th, no, the 6th of November.", "We'll launch on the 6th of November."],
  ['The price is 5 dollars, no, 6 dollars.', 'The price is 6 dollars.'],
  ['Room 204, sorry, 205.', 'Room 205.'],
  ['It takes 10, I mean 15 seconds.', 'It takes 15 seconds.'],
  ['The total is 50, correction, 60.', 'The total is 60.'],
  ["Let's meet on Monday, no, Tuesday.", "Let's meet on Tuesday."],
  // A unit said once stays with the corrected number.
  ['Meet me at 3 pm, no, 4.', 'Meet me at 4 pm.'],
  ['Order two coffees, make that three.', 'Order three coffees.'],
  // Names.
  ['Send it to Rahul, sorry, Rohit.', 'Send it to Rohit.'],
  ['We flew to Paris, no, London.', 'We flew to London.'],
  ['Ask Priya, no, Sam, to review it.', 'Ask Sam, to review it.'],
  // Places, things, colours, and the same verb said again.
  ['Put it in the drawer, actually, in the cupboard.', 'Put it in the cupboard.'],
  ['I want the red one, no, the blue one.', 'I want the blue one.'],
  ['Bring the charger, no, the cable and the mouse.', 'Bring the cable and the mouse.'],
  ['Paint it red, no, blue.', 'Paint it blue.'],
  ['We should test the build, no, test the installer.', 'We should test the installer.'],
  ['The meeting is on Monday, no, the meeting is on Tuesday.', 'The meeting is on Tuesday.'],
  ['Send the file to me, no, to Priya.', 'Send the file to Priya.'],
  // Two corrections in one dictation.
  ['I have 2 kids, no, 3 kids, sorry, 4 kids.', 'I have 4 kids.'],
  // A correction at the start of the sentence keeps its capital.
  ['The 5th, no, the 6th.', 'The 6th.'],
  // A whole statement taken back and said again. The first is the real test
  // dictation that the phrase rules alone did not touch (Parakeet, 2026-10-05).
  ["Yes, let's commit. And push to mean. No, no, don't push to main. Maybe We can revert it back.",
    "Yes, let's commit. Don't push to main. Maybe We can revert it back."],
  ["Let's commit and push to main, no, no, don't push to main.", "Let's commit and don't push to main."],
  ['Ship it today. No, no, ship it tomorrow.', 'Ship it tomorrow.'],
  ['We tested the build. No, no, we tested the installer.', 'We tested the installer.'],
  ['I want pizza. No, I want pasta.', 'I want pasta.'],
  ['I want to send the report, no, I want to share the report.', 'I want to share the report.'],
  ["Don't push to main. No, no, push to main.", 'Push to main.'],
  ['Call him at 5. No, no, call him at 6.', 'Call him at 6.'],
  ['Add a dark mode. No, no, add a light mode.', 'Add a light mode.'],
];

const kept = [
  // Apologies and answers.
  'I talked to John, sorry for the delay.',
  'Sorry, my bad again, it closed.',
  'He said no to the plan.',
  'Thanks, no worries.',
  'Call me at 5, no rush.',
  'Is it ready, no, it isn\'t.',
  'I said, no, I won\'t go to Paris.',
  'There is no time, no money left.',
  // Said to the listener, not a correction of these words.
  'No, no, you have gone way too different.',
  'No, sir, no, sir. I need to do it.',
  'No, I mean C F A, and P E K.',
  // Questions.
  'So add those things, no? Those are already there in the camera.',
  'Did you understand what I mean? Like, the arrow should be under the bow.',
  // A new thought, not a swap.
  'The man is throwing it in the bag. No, it shouldn\'t be like that.',
  'Put it in the box, no, the box is full.',
  "We'll go on Monday, actually, Tuesday works better.",
  // The same shape at the start of a sentence: a swap or a new thought, it
  // cannot be told from the words, so it stays as said.
  'Monday, no, Tuesday works for me.',
  'Meet me in London, actually, Paris is better.',
  'We need the money, sorry, the delay was mine.',
  'See you at 3, actually, I can\'t make it.',
  'Add 3 eggs, wait, the recipe says 2.',
  // An explanation, not a replacement.
  'I told you not to show it from the bottom. I mean, see, it is isometric.',
  'The file is in the folder, I mean, the one on the desktop.',
  'Talk to John, I mean, John from sales.',
  'We should, I mean, probably leave.',
  // Said twice on purpose.
  'Go on Monday, no, Monday.',
  // Nothing after the cue, or nothing that lines up.
  'Go to the park, no, no, no.',
  "I don't see any Next. build, no, in the action tab.",
  'It is working, actually, better than before.',
  'Yes, no, maybe.',
  // Statements that only sound taken back.
  'You changed the colors. No, no, I said keep the colors.',
  'You pushed it to main. No, no, push it to the branch.',
  'Should we push to main? No, no, don\'t push to main.',
  'I love this design. Actually, I love the colors.',
  'I love this design. I mean, I love the colors.',
  'I broke the build. Sorry, I broke it again.',
  'Push to main. No, no, push to main.',
  "Let's push to main. Wait, let's run the tests first.",
  'Fix the login bug. No, but fix it after lunch.',
  'Check the logs. No, the logs are fine, I checked them.',
  // Adds to the first statement, or points back at it: both need it kept.
  'It works on Windows. No, no, it works on Mac too.',
  'Use the blue button. No, no, use it for the header only.',
  'Merge the branch. Wait, merge it after the review.',
];

let checks = 0;
for (const [said, want] of corrected) {
  const got = applySpokenCorrections(said);
  assert.strictEqual(got.text, want, 'corrects: ' + said);
  assert(got.removed.length > 0, 'reports what it took out: ' + said);
  checks++;
}
for (const said of kept) {
  const got = applySpokenCorrections(said);
  assert.strictEqual(got.text, said, 'keeps: ' + said);
  assert.deepStrictEqual(got.removed, [], 'reports nothing taken out: ' + said);
  checks++;
}

// What was taken out is reported, words and cue, for the history entry.
assert.deepStrictEqual(applySpokenCorrections('The cat is running on the field, no, no, in the park.').removed,
  ['on the field, no, no,']);
checks++;
// It only ever takes words out: every word it pastes was said.
for (const [said] of corrected) {
  const words = s => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  const left = words(said);
  for (const w of words(applySpokenCorrections(said).text)) {
    const at = left.indexOf(w);
    assert(at >= 0, 'pastes only words that were said: ' + said);
    left.splice(at, 1);
  }
}
checks++;
assert.deepStrictEqual(applySpokenCorrections(''), { text: '', removed: [] });
assert.deepStrictEqual(applySpokenCorrections(null), { text: '', removed: [] });
checks++;

// --- A model's edit, checked -------------------------------------------------
// The model names pieces to take out (server/corrections.js); every piece below
// is one a model really returned in the 2026-10-05 trial on his dictations.
const { checkModelEdit, mayTakeBack, removePieces } = require('../src/spoken-corrections');
const modelEdit = (said, pieces) => {
  const edited = removePieces(said, pieces);
  return edited === null ? null : checkModelEdit(said, edited);
};

const usedEdits = [
  ["Okay, uh, so let's Uh walk into the Plane field. Uh. No, no, uh... Not in the plain field. Let's, uh... put it in, uh, in the water.",
    ["walk into the Plane field. Uh. No, no, uh... Not in the plain field. Let's, uh..."],
    "Okay, uh, so let's Uh put it in, uh, in the water."],
  ["Yes, let's commit. And push to mean. No, no, don't push to main. Maybe We can revert it back.",
    ['And push to mean. No, no,'], "Yes, let's commit. Don't push to main. Maybe We can revert it back."],
  ['so if they spell it like Uh, the cat is running on the field. Uh, no, no. in the park. So it pays the park.',
    ['on the field. Uh, no, no.'], 'so if they spell it like Uh, the cat is running in the park. So it pays the park.'],
  ["Let's meet at 3, no, 4 tomorrow.", ['3, no,'], "Let's meet at 4 tomorrow."],
  ['Mother smile ton my Uh, doesn\'t have a car. No. He has a car.', ["doesn't have a car. No."], 'Mother smile ton my Uh, He has a car.'],
  // Most of a short dictation can be what was taken back.
  ['Ship it today. No, no, ship it tomorrow.', ['Ship it today. No, no,'], 'Ship it tomorrow.'],
];
for (const [said, pieces, want] of usedEdits) {
  const got = modelEdit(said, pieces);
  assert(got, 'uses a piece that is words taken back, a cue and an echo: ' + pieces[0]);
  assert.strictEqual(got.text, want);
  checks++;
}

const refusedEdits = [
  // Each would have cut words the speaker meant.
  ["No, it's not working, man. The spoken correction is not working.", ['No,'], 'an answer, starting with the cue'],
  ['No, no, you gone too way too different. like we can keep it the same.', ['No, no,'], 'disagreeing with the listener'],
  ["He is throwing it in the bag. No, it shouldn't be like that. He should put it inside.", ["No, it shouldn't be like that."], 'a cue with nothing taken back'],
  ["Yes, let's commit. And push to mean. No, no, don't push to main. Maybe We can revert it.", ["And push to mean. No, no, don't push to"], 'half of the new words'],
  ["Let's meet at 3, no, 4 tomorrow.", ['at 3, no, 4'], 'the new number itself'],
  ["So will that affect anything like Uh, I, I sorry, I really didn't know, like You were working.", ['I, I sorry,'], 'a stutter and an apology'],
  ["So will that affect anything like Uh, I, I sorry, I really didn't know, like You were working.", ["Uh, I, I sorry, I really didn't know, like"], 'a sentence that was meant'],
  ['You changed the colors to red. No, no, I said keep the colors.', ['You changed the colors to red. No, no,'], 'something about the listener'],
  ['Should we push it today? No, no, push it tomorrow.', ['Should we push it today? No, no,'], 'a question that was asked'],
  ['Send the report to the team today and ask them to review it. No.', ['Send the report to the team today and ask them to review it. No.'], 'most of the dictation'],
  ['Ship the build today, no, ship it tomorrow.', ['build'], 'a word with no cue near it'],
];
for (const [said, pieces, why] of refusedEdits) {
  assert.strictEqual(modelEdit(said, pieces), null, 'refuses ' + why + ': ' + pieces[0]);
  checks++;
}
// A model that rewrites instead of only taking out is refused whatever it wrote.
assert.strictEqual(checkModelEdit('Meet at 3, no, 4 tomorrow.', 'Meet at four tomorrow.'), null);
assert.strictEqual(checkModelEdit('Meet at 3, no, 4 tomorrow.', 'Meet at 3, no, 4 tomorrow.'), null, 'nothing taken out, nothing to use');
// A piece that is not in the dictation, or not where the order says, is no edit.
assert.strictEqual(removePieces('Meet at 3, no, 4.', ['at 5, no,']), null);
assert.strictEqual(removePieces('Meet at 3, no, 4 and 5.', ['4', '3, no,']), null);
assert.strictEqual(removePieces('Ship it Monday. No, no, ship it Tuesday.', ['Ship it Monday. No, no,']), 'Ship it Tuesday.');
checks++;

// Only a dictation with a cue after some words is ever sent.
assert.strictEqual(mayTakeBack('The cat is running on the field, no, in the park.'), true);
assert.strictEqual(mayTakeBack('Send it to Rahul, sorry, Rohit.'), true);
assert.strictEqual(mayTakeBack('It is in the folder, I mean, the other one.'), true);
assert.strictEqual(mayTakeBack('Please send the notes when we are done.'), false);
assert.strictEqual(mayTakeBack('No, that is fine.'), false, 'a cue with nothing before it');
assert.strictEqual(mayTakeBack('That is what it means.'), false);
checks++;

console.log('All ' + checks + ' spoken correction checks passed.');
