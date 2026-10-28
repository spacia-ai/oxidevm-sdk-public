# Unicode-DFS-2016 dependency review

Status: technical review prepared. Human legal review of the first release remains required.

SWC `@swc/wasm-web@1.16.18`, source revision
`63ced3ba33a9c31737ad056b39c9a8cdb4fcc486`, includes
`unicode-id-start@1.3.1`. Its expression is
`(MIT OR Apache-2.0) AND Unicode-DFS-2016`. Select
`MIT AND Unicode-DFS-2016`. The Unicode term cannot be removed.

The [SPDX license text](https://spdx.org/licenses/Unicode-DFS-2016.html)
permits use, modification, distribution, and sale. It requires retention of
the copyright and permission notice in copies or associated documentation.
It disclaims warranties and restricts promotional use of copyright-holder
names. It does not require distribution of application source.

Retain the exact upstream `LICENSE-UNICODE` and `LICENSE-MIT` files in the
compiler notices. Do not replace the 2016 text with the current Unicode v3
text. Record the selected expression in the artifact SBOM.

This narrowly adds the historical identifier to the permissive policy. It
does not approve other Unicode content, fonts, or unknown licenses. The
release manifest binds this policy revision and its full notices to the
required owner and legal reviews.
