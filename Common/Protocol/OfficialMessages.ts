/** Raw deployment text from supplied FXGS PE, NOT localized port strings.
 * OnEventItem0041F28B formats aS_3 at0048F010: "%s" + this88-byte suffix.
 * IDA lists the non-ASCII suffix as separate db rows: "%s" is NOT the full C
 * string. It is CP949 Korean even in this BNB_TAIWAN binary. Meaning:
 * "[name] obtained an event item! Congratulations!\nFor details, refer to the
 * homepage~\n". Preserve original bytes regardless of configured name encoding;
 * translating/re-encoding this suffix as Big5 would change native wire output.
 * No reward, inventory change, homepage fetch, or event-file log is implied.
 * Hex is immutable; each packet gets a detached Buffer, never a shared mutable
 * Buffer exported as a supposedly readonly constant.
 */
export const EventItemAnnouncement = {
  TemplateVA: 0x0048f010,
  SourceEncoding: "cp949",
  SuffixHex:
    "b4d4b2b2bcad20c0ccbaa5c6ae20bec6c0ccc5dbc0bb20c8b9b5e6c7cfbcccbdc0b4cfb4d92120c3e0c7cfc7d5b4cfb4d9210ac0dabcbcc7d120b3bbbfebc0ba20c8a8c6e4c0ccc1f6b8a620c2fcb0edc7cfbcbcbfe47e0a",
} as const;
