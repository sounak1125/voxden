Version: 2.1.9
Released: 8 October 2026

Names and long words come through whole, and a word you break off and start again is left out. Voxden Cloud now listens for up to 100 words from your dictionary.

## What's new

- Voxden Cloud no longer cuts a word in two when it sends a long dictation in pieces. Pieces are longer and split at a real pause, so a name you slow down on, like "Higgs... field", arrives as one word, and the model hears enough of each sentence to spell names right. Short dictations go up in one piece.
- If a cloud piece still ends partway through a word, Voxden joins it to the rest of the word in the next piece.
- Your microphone audio is cleaner, so "s" and "f" sounds come through more clearly.
- Local dictation splits a long recording in a gap between words, not in the middle of one.
- Voxden keeps the cloud model ready for as long as you are speaking, so the last words of a long dictation come back without a slow start.
- A word you break off and start again, as in "I am check- checking it", now leaves only the finished words: "I am checking it". Verbatim mode still keeps everything you said.
- Voxden Cloud now listens for up to 100 words from your dictionary instead of 30. This already works in older versions too.
- Editing a transcript no longer suggests a dictionary rule that would replace an everyday word, like "there" or "people", in every later dictation.
- If you read aloud for a long time with only short pauses, Voxden Cloud still sends your words in pieces as you go, so a very long dictation no longer fails at the end.
- On a Mac, a shortcut you record with the Control key now uses Control, not Command. A shortcut with a key a Mac keyboard lacks, such as Insert, is refused instead of firing on Cmd+Shift alone, and the "Mute other audio" switch, which only works on Windows, is hidden.
- Security updates: Voxden now runs on Electron 43.7.9, and it starts Windows PowerShell from its system folder only.

## Installing or updating

**Windows:** Install the update in Voxden or download the installer. Voxden is not yet code-signed; if SmartScreen appears, choose **More info**, then **Run anyway**.

**Mac:** Download the Apple Silicon build from [voxden.app/download](https://voxden.app/download) and replace Voxden in Applications. Mac updates are installed manually. Follow the first-run steps on the download page if macOS blocks opening the app.
