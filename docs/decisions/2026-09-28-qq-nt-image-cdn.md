# QQ NT screenshot downloads

## Context

A quoted QQ screenshot could be recovered through OneBot but the bridge rejected its URL before
downloading. NapCat returns QQ NT images from `https://multimedia.nt.qq.com.cn`, which is not a
subdomain of the previously allowed `qq.com` suffix.

## Decision

Allow that exact HTTPS hostname in addition to the existing QQ CDN hosts. Do not allow the entire
`qq.com.cn` namespace or arbitrary subdomains of the added hostname. Existing credential, port,
redirect, download-size and image-normalization checks still apply.

## Validation

The URL policy regression test covers the observed QQ NT download shape and rejects HTTP,
lookalike suffixes, extra subdomains and unrelated `qq.com.cn` hosts. Deployment verification
recovers a previously rejected quoted screenshot before replaying its support request.
