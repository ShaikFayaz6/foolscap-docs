# Markdown with things Foolscap removes

This paragraph should import normally, with **bold** and *italic*.

<script>alert('this script must not survive import')</script>

<div style="color:red" onclick="alert(1)">Raw HTML blocks like this are dropped.</div>

![A picture that Foolscap leaves out](https://example.com/picture.png)

| A | Markdown | Table |
| - | -------- | ----- |
| 1 | 2        | 3     |

[A link](https://example.com) keeps its words but not the link.

Text after everything above should still be here.
