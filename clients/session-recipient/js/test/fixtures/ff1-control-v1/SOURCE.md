# ff1-control-v1 fixtures (vendored)

These files are a verbatim copy of
`components/feral-controld/control/testdata/fixtures/` from
`feral-file/ffos-user` at commit `25d776c` (ffos-user#414, display grants).
85 JSON files: keys.json, 20 positive and 64 negative. `keys.json` carries a
`controllers.display` key (role `display`, platform `web`, an origin) and the
`cmd-display-*` / `display-*` vectors exercise it; their `setup.displayGrants`
lists the display records the device holds.

The normative spec is `docs/ff1-control-v1.md` in the same commit; §12 defines
the fixture format. The Go generator is
`components/feral-controld/control/internal/fixturegen`.

Do not edit these files by hand. To update them, regenerate them in ffos-user
(`go run ./control/cmd/genfixtures` from `components/feral-controld`), copy the
directory here, and update the commit above. `test/control-conformance.test.ts`
runs every request, reply and approval-code vector.
