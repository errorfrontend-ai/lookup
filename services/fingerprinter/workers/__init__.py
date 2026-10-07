"""The queue workers that run the fingerprint engine (docs/design/step-3-engine-hookup.md).

* `python -m workers.ingest` takes `ingest` jobs: an uploaded ad is downloaded through a short-lived
  address, checked, fingerprinted and stored, and the ad becomes READY (or FAILED with a reason).
* `python -m workers.recognize` takes `recognize` jobs: a listener's clip is matched against the
  stored fingerprints and the matched recording's number is returned to the API.

Neither has storage credentials, a portal or any station data: the worker's database role reaches
only the `fingerprints` schema and one function that records an ingest result.
"""
