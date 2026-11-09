// Works out the job time estimate (with the full route search) off the page's
// thread, so editing a large job doesn't freeze the Job page. The page posts
// { id, job, machine } and gets back { id, est } (or { id, error }).
'use strict';
importScripts('../shared/core.js');

self.onmessage = (e) => {
  const { id, job, machine } = e.data;
  try {
    self.postMessage({ id, est: self.CC.estimate(job, machine) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
