# 随包字体许可（fonts/）

本目录下的 woff2 是从系统安装的开源字体**子集化**而来，两份字体均为 **SIL Open Font License 1.1**，可再分发。以下为各自字体内嵌的版权与许可记录（从 TrueType `name` 表原样读出，未改写）。

## qihe-emoji-subset.woff2

- 来源：Google Noto Color Emoji（`NotoColorEmoji.ttf`），子集化到本应用在用的 48 个码位，保留 CBDT/CBLC 位图表
- nameID 0（Copyright）：`Copyright 2022 Google Inc.`
- nameID 13（License）：`This Font Software is licensed under the SIL Open Font License, Version 1.1. This Font Software is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the SIL Open Font License for the specific language governing permissions and limitations under it.`
- nameID 14（License URL）：`http://scripts.sil.org/OFL`

## noto-sans-sc-400-subset.woff2 / noto-sans-sc-700-subset.woff2

- 来源：Adobe/Google 思源黑体 Noto Sans CJK SC（`NotoSansCJK-Regular.ttc` 索引 2、`NotoSansCJK-Bold.ttc` 索引 2），子集化到 GB2312 全字集 + 常用补充字
- nameID 0（Copyright）：`© 2014-2021 Adobe (http://www.adobe.com/).`
- nameID 13 / 14：同上（SIL OFL 1.1，`http://scripts.sil.org/OFL`）

## 生成方式与再分发口径

子集由 `pyftsubset`（fontTools）按码位清单生成，码位清单与生成参数见 `../fonts.css` 内注释。OFL 要求随字体附带许可证文本：本文件记录了字体自带的版权与许可声明及官方链接；**如需严格符合"许可证全文随包"，应在此目录再放一份 OFL 1.1 原文**（`OFL.txt`），本项目当前未放，已作为待办登记。
