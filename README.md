# SkyHand

Fly a virtual camera drone with your hand. SkyHand is a browser-based 3D drone simulator built with p5.js and ml5.js hand tracking, featuring hills, a lake, a small town, wind, and a race course.

[Play SkyHand](https://alzin.github.io/skyhand/)

## Getting started

Open the live demo in a modern browser with WebGL support. Allow webcam access for hand tracking, hold up an open palm, and select **Start flying**. You can also fly with the keyboard without a camera.

Internet access is needed to load p5.js, ml5.js, the hand-tracking model, and Google Fonts. Camera access requires HTTPS or localhost. The application uses the webcam for browser-side hand tracking; its source does not implement a video upload service.

## Run locally

Clone this repository and serve its directory with any static HTTP server. For example, with Python installed:

```sh
git clone https://github.com/alzin/skyhand.git
cd skyhand
python -m http.server 8000
```

Open <http://localhost:8000>. No package installation or build step is required.

## Controls

### Hand gestures

| Gesture | Action |
| --- | --- |
| Pinch and hold | Take off or land; the pose sets the neutral position |
| Raise or lower your hand | Climb or descend |
| Tilt fingers toward the screen / back | Fly forward / reverse |
| Tilt like a steering wheel | Turn |
| Move left or right | Slide sideways |
| Make a fist | Brake and hover |

Press **T** to switch to two-hand control: the left hand controls altitude and turn, while the right controls forward/back and sideways movement.

### Keyboard and mouse

| Key | Action |
| --- | --- |
| W / S | Forward / back |
| A / D | Slide left / right |
| Up / Down arrows | Climb / descend |
| Left / Right arrows | Turn |
| Space | Take off / land |
| H | Return home |
| C | Cycle chase, FPV, gimbal, and pilot cameras |
| F | Cycle cine, normal, sport, and attitude flight modes |
| T | Switch one-hand / two-hand control |
| G | Change wind strength |
| P | Take a photo |
| M | Toggle sound |
| R | Reset the drone |
| Mouse wheel | Adjust chase camera distance |

## Source layout

| File | Purpose |
| --- | --- |
| `index.html`, `style.css` | Start screen, help, and styling |
| `sketch.js` | Main loop, camera modes, and input |
| `world.js` | Terrain, town, lake, forest, sky, and race course |
| `drone.js` | Drone physics, flight controller, model, and particles |
| `hands.js` | Webcam tracking and gesture controls |
| `hud.js` | Flight display |
| `audio.js` | Synthesized rotor audio |
| `utils.js` | Math, filters, textures, and mesh helpers |

Scripts share browser globals and load in the order listed in `index.html`.

## Deployment

GitHub Pages serves the root of the `main` branch. Changes pushed to `main` are published automatically. The `.nojekyll` file enables plain static hosting; no backend or environment variables are required.

## Contributing

Contributions, bug reports, and ideas are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and verification checklist. Open an issue to discuss substantial changes, or submit a focused pull request.

## License

SkyHand's source is available under the [MIT License](LICENSE). Third-party libraries, fonts, and model assets remain under their respective licenses.
