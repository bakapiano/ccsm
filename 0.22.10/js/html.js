// htm bound to preact's h — gives us JSX-like template literals with no build step.

import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
