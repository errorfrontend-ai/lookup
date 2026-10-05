# Common-password blocklist

`common-passwords.txt.gz` holds 5,530 common passwords that are 15 to 128 characters long (the only
ones our policy could otherwise accept), most common first, normalised to NFC and lower case.

Built on 5 October 2026 from SecLists (MIT licence, https://github.com/danielmiessler/SecLists):

- `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`
- `Passwords/Common-Credentials/Pwdb_top-1000000.txt`

OWASP ASVS 5.0 (6.2.4) asks for at least the top 3,000 passwords that match the policy; the NCSC list
alone has only 329 entries of 15 characters or more, so the larger list is included.

SecLists is © Daniel Miessler and contributors, MIT licence: permission is granted to use, copy,
modify and distribute the software, provided the copyright notice and permission notice are kept.
