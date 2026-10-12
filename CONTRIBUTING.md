# Contributing to SkyHand

Thanks for helping improve SkyHand. Bug reports, documentation improvements, accessibility fixes, performance work, and new flight experiences are welcome.

## Workflow

1. Fork the repository and create a branch for your change.
2. Serve the project locally using the instructions in the README.
3. Keep the change focused and follow the surrounding JavaScript style. Preserve script load order and shared global dependencies.
4. Verify the affected behavior in a browser, then open a pull request explaining the change and how you tested it. Include screenshots or a short recording for visual changes.

Discuss large changes in an issue before investing substantial implementation time.

## Verification

There is no automated test suite yet. With Node.js installed, check JavaScript syntax using `node --check <filename.js>` for each changed script. For browser changes, check:

- The start screen and 3D scene load without console errors.
- Keyboard takeoff, steering, landing, and reset work with camera permission denied.
- Hand tracking and affected gestures work with camera permission granted, when a webcam is available.
- Camera modes, help, sound, and window resizing still work when affected.

State any untested hardware or browser paths in your pull request.

## Reporting bugs

Include your browser and operating system, steps to reproduce, expected and actual results, and relevant console errors. For tracking issues, mention whether camera permission was granted and whether one-hand or two-hand mode was active. Avoid sharing private camera footage or credentials.

## Community and licensing

Be respectful, constructive, and welcoming. By submitting a contribution, you agree that it may be distributed under this project's MIT License. Only contribute code and assets you have the right to share, and preserve required third-party notices.
