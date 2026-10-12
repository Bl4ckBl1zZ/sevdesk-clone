# Fixture provenance and licences

| File | Source | Licence |
|---|---|---|
| `xrechnung-ubl-valid.xml` | Unmodified copy of `instances/standard/01.01a-INVOICE_ubl.xml` from the KoSIT **XRechnung Test Suite v2026-08-31** (`xrechnung-3.0.2-testsuite-2026-08-31.zip`, SHA-256 `1e81ef7563e0fa04c0e0b0631318a7e0843a3c0beb57d83ef95ac0c4a095e3d7`, https://github.com/itplr-kosit/xrechnung-testsuite/releases/tag/v2026-08-31). CRLF line endings kept. | Apache License 2.0, © Koordinierungsstelle für IT-Standards (KoSIT) |
| `xrechnung-ubl-invalid.xml` | **Modified** copy of the same file (Apache-2.0 §4b: changed by us): the `cbc:BuyerReference` line (BT-10) was removed and `cbc:PayableAmount` changed from `336.9` to `999.99`. KoSIT 1.6.3 + config 2026-08-31 rejects it with `BR-DE-15` and `BR-CO-16`. | Apache License 2.0 (derived work) |
| `zugferd-xrechnung-valid.pdf` | Generated with Mustang CLI 2.26.0 from `instances/standard/01.01a-INVOICE_uncefact.xml` of the same test suite: `--action pdf --language de`, then `--action combine --format zf --version 2 --profile X`. Mustang validate: valid (PDF/A-3u + XRechnung CII). | Apache License 2.0 (derived work) |
| `pdf-without-xml.pdf` | Generated with Mustang CLI 2.26.0 `--action pdf --language de` from `xrechnung-ubl-valid.xml` (visual PDF only, no embedded XML). Mustang validate: invalid ("XML could not be extracted"). | Apache License 2.0 (derived work) |
| `reports/kosit-*.xml` | Responses of the KoSIT validator 1.6.3 daemon (`-D`) with `xrechnung-3.0.2-validator-configuration-2026-08-31` for the XML fixtures above (`accept` = 200, `reject` = 406, `no-scenario` = `<foo/>` → 406, `422` = not well-formed input). | Validator output |
| `reports/mustang-*.xml` | stdout of `Mustang-CLI-2.26.0.jar --no-notices --action validate` for the fixtures above. | Validator output |

Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
