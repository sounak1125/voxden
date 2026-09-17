# Voxden privacy policy

Last updated: 17 September 2026

Voxden is a dictation app for Windows made by Sounak. This page says what it
keeps, where, and what you can do about it. It is written to match what the
software does; if the software changes, this page changes with it.

## On your PC

Dictation on the Free plan runs entirely on your computer. Your voice is
turned into text by a speech model installed on your PC and never leaves it.

Voxden keeps these on your PC, in its own data folder, and nowhere else:

- Your dictation history, so you can copy or review what you said.
- Your personal dictionary and the words it learns from your corrections.
- Audio recordings only if you turn on "Keep recordings" or "Keep audio for
  training" in Settings. Both are off by default, and you can delete the
  recordings from Settings at any time.
- Your settings.

## Your account

Voxden asks you to sign in. You can sign in with an emailed code or with
Google. Either way, the account service stores:

- Your email address.
- Which plan you are on and until when.
- A session token for each PC you signed in on, stored as a hash.
- If you pay for Pro, the subscription's provider, status and renewal date.
  Payments are handled by Razorpay; Voxden never sees your card details.

Signing in with Google asks Google only for your email address and basic
profile. Voxden stores the email address and nothing else from Google. It does
not read your Gmail, contacts, calendar or files.

## Voxden Cloud

If you turn on Voxden Cloud, audio of what you dictate is sent to the account
service and forwarded to a third-party speech recognition provider to be
turned into text. The service records how many seconds were transcribed, to
count against your plan. Audio is not stored by the account service after the
text comes back. Voxden Cloud is off unless you turn it on.

## Feedback

If you send feedback from the Help menu, the message you wrote is stored by
the account service and forwarded to a private Discord channel that only the
developer can see. App details (version, engine, plan) are attached only if
you leave that option on. Your email address is included only if you are
signed in or type it in.

## What Voxden does not do

- No advertising, and no data is sold or shared for advertising.
- No analytics or tracking of what you type or where you dictate.
- No reading of the apps you dictate into beyond placing the text there.

## Deleting your data

Sign out from Settings to remove the session from your PC. Uninstalling
Voxden and deleting its data folder removes everything it kept locally. To
delete your account and everything the account service holds about it, send a
request from the Help menu or open an issue at
https://github.com/sounak1125/voxden/issues.

## Contact

Questions about this policy: open an issue at
https://github.com/sounak1125/voxden/issues.
