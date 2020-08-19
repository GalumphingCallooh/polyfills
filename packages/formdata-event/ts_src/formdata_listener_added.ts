/**
 * @license
 * Copyright (c) 2020 The Polymer Project Authors. All rights reserved. This
 * code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt The complete set of authors may be
 * found at http://polymer.github.io/AUTHORS.txt The complete set of
 * contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt Code
 * distributed by Google as part of the polymer project is also subject to an
 * additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

/**
 * This module takes information about 'formdata' listeners added or removed
 * from nodes and manages the listeners for 'submit' events that watch for form
 * submissions that should dispatch a 'formdata' event.
 */

import {getTarget, getDefaultPrevented} from './environment_api/event.js';
import {addEventListener, removeEventListener} from './environment_api/event_target.js';
import {getRootNode} from './environment_api/node.js';
import {setSubmitEventPropagationStoppedCallback, setSubmitEventPropagationImmediatelyStoppedCallback} from './wrappers/event.js';
import {dispatchFormdataForSubmission} from './dispatch_formdata_for_submission.js';
import {EventListenerArray} from './event_listener_array.js';

/**
 * The set of 'formdata' event listeners for an event target.
 */
const targetToFormdataListeners = new WeakMap<EventTarget, EventListenerArray>();

/**
 * This function should be called when any 'formdata' event listener is added to
 * `target`. If this is the first 'formdata' event listener added to `target`,
 * then it will also add the 'submit' listener.
 */
export const formdataListenerAdded = (
  target: EventTarget,
  callback: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
) => {
  // If this listener's `callback` is null, the browser ignores it.
  if (!callback) {
    return;
  }

  const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
  const formdataListeners = targetToFormdataListeners.get(target);

  // When the first 'formdata' listener is added, also add the 'submit'
  // listener.
  if (formdataListeners === undefined) {
    const listeners = new EventListenerArray();
    listeners.push({callback, capture});
    targetToFormdataListeners.set(target, listeners);
    addEventListener.call(target, 'submit', submitCallback, true);
    return;
  }

  formdataListeners.push({callback, capture});
};

/**
 * This function should be called when any 'formdata' event listener is removed
 * from `target`. If this is the last 'formdata' event listener on `target`,
 * then it will also remove the 'submit' listener.
 */
export const formdataListenerRemoved = (
  target: EventTarget,
  callback: EventListenerOrEventListenerObject | null,
  options?: boolean | EventListenerOptions,
) => {
  // Event listeners with null callbacks aren't stored.
  if (!callback) {
    return;
  }

  const formdataListeners = targetToFormdataListeners.get(target);
  if (formdataListeners === undefined) {
    return;
  }

  const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);

  formdataListeners.delete({callback, capture});

  // When the last 'formdata' event listener is removed, also remove the
  // 'submit' listener.
  if (formdataListeners.length === 0) {
    targetToFormdataListeners.delete(target);
    removeEventListener.call(target, 'submit', submitCallback, true);
  }
};

/**
 * The set of 'submit' event listeners for an event target.
 */
const targetToSubmitListeners = new WeakMap<EventTarget, EventListenerArray>();

/**
 * This function should be called when any 'submit' event listener is added to
 * `target`.
 */
export const submitListenerAdded = (
  target: EventTarget,
  callback: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
) => {
  // If this listener's `callback` is null, the browser ignores it.
  if (!callback) {
    return;
  }

  if (!targetToSubmitListeners.has(target)) {
    targetToSubmitListeners.set(target, new EventListenerArray());
  }

  const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
  const submitListeners = targetToSubmitListeners.get(target)!;
  const initialSubmitListenerCount = submitListeners.length;

  submitListeners.push({callback, capture});

  // Was the new listener added? (i.e. Was it not deduplicated?)
  if (submitListeners.length > initialSubmitListenerCount) {
    // Remove and re-add `finalSubmitCallback` to move it to the end of the list
    // of listeners for the given phase.
    removeEventListener.call(target, 'submit', finalSubmitCallback, capture);
    addEventListener.call(target, 'submit', finalSubmitCallback, capture);
  }
};

/**
 * This function should be called when any 'submit' event listener is removed
 * from `target`.
 */
export const submitListenerRemoved = (
  target: EventTarget,
  callback: EventListenerOrEventListenerObject | null,
  options?: boolean | EventListenerOptions,
) => {
  // Event listeners with null callbacks aren't stored.
  if (!callback) {
    return;
  }

  const submitListeners = targetToSubmitListeners.get(target);
  if (submitListeners === undefined) {
    return;
  }

  const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);

  submitListeners.delete({callback, capture});

  // If there are no remaining capturing 'submit' listeners, remove the
  // capturing `finalSubmitListener`.
  if (capture && submitListeners.capturingCount === 0) {
    removeEventListener.call(target, 'submit', finalSubmitCallback, capture);
  }

  // If there are no remaining bubbling 'submit' listeners, remove the bubbling
  // `finalSubmitListener`.
  if (!capture && submitListeners.bubblingCount === 0) {
    removeEventListener.call(target, 'submit', finalSubmitCallback, capture);
  }
};

const eventToPropagationStopped = new WeakMap<Event, true>();

/**
 * This callback listens for 'submit' events on EventTargets with other 'submit'
 * event listeners. The callback listens at both the capturing and bubbling
 * phases, if any other listener at that phase is added, and is moved by
 * `submitListenerAdded` to always be the *last* 'submit' listener for that
 * phase.
 */
const finalSubmitCallback = (event: Event) => {
  // If the event's propagation was stopped by `stopPropagation` but not
  // cancelled, dispatch the 'formdata' event.
  if (eventToPropagationStopped.has(event) && !getDefaultPrevented(event)) {
    dispatchFormdataForSubmission(getTarget(event));
  }
};

/**
 * Tracks whether or not a given 'submit' event has already been seen by
 * `submitCallback`. IE11 does not support WeakSet, so a WeakMap<K, true> is
 * used instead.
 */
const submitEventSeen = new WeakMap<Event, true>();

interface SubmitEventBubblingListener {
  readonly target: EventTarget;
  readonly callback: EventListener;
}

/**
 * Tracks the bubbling listener added for a given 'submit' event.
 */
const submitEventToListenerInfo = new WeakMap<Event, SubmitEventBubblingListener>();

/**
 * This callback listens for 'submit' events propagating through the target and
 * adds another listener that waits for those same events to reach the shallow
 * root node, where it calls `dispatchFormdataForSubmission` if the event wasn't
 * cancelled.
 */
const submitCallback = (capturingEvent: Event) => {
  // Ignore any events that have already been seen by this callback, which could
  // be in the event's path at more than once.
  if (submitEventSeen.has(capturingEvent)) {
    return;
  }
  submitEventSeen.set(capturingEvent, true);

  // Ignore any 'submit' events that don't target forms.
  const target = getTarget(capturingEvent);
  if (!(target instanceof HTMLFormElement)) {
    return;
  }

  const shallowRoot = getRootNode(target);

  const bubblingCallback = function(bubblingEvent: Event) {
    // Ignore any other 'submit' events that might bubble to this root.
    if (bubblingEvent !== capturingEvent) {
      return;
    }

    removeEventListener.call(shallowRoot, 'submit', bubblingCallback);
    submitEventToListenerInfo.delete(capturingEvent);

    // Ignore any cancelled events.
    if (getDefaultPrevented(bubblingEvent)) {
      return;
    }

    dispatchFormdataForSubmission(target);
  };
  submitEventToListenerInfo.set(capturingEvent, {
    target: shallowRoot,
    callback: bubblingCallback,
  });

  // Listen for the bubbling phase of any 'submit' event that reaches the root
  // node of the tree containing the target form.
  addEventListener.call(shallowRoot, 'submit', bubblingCallback);
};

/**
 * This function will be called when any 'submit' event's propagation is stopped
 * by `stopPropagation`.
 */
setSubmitEventPropagationStoppedCallback((event: Event) => {
  const listenerInfo = submitEventToListenerInfo.get(event);
  if (listenerInfo) {
    const {target, callback} = listenerInfo;
    removeEventListener.call(target, 'submit', callback);
  }

  eventToPropagationStopped.set(event, true);
});

/**
 * This function will be called when any 'submit' event's propagation is stopped
 * by `stopImmediatePropagation`.
 */
setSubmitEventPropagationImmediatelyStoppedCallback((event: Event) => {
  const listenerInfo = submitEventToListenerInfo.get(event);
  if (listenerInfo) {
    const {target, callback} = listenerInfo;
    removeEventListener.call(target, 'submit', callback);
  }

  // Ignore any cancelled events.
  if (!getDefaultPrevented(event)) {
    dispatchFormdataForSubmission(getTarget(event));
  }
});