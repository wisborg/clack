/**
 * The published manifest schema (schema/manifest-1.schema.json), as the
 * build ships it -- its rules without its explanations -- compiled two ways:
 * the document around its slides, and one slide. A large manifest is then
 * checked a slide at a time, with the page free in between, and slides
 * given from script are checked by the same rules as a manifest's.
 */
import manifestSchema from "../schema/manifest-1.schema.json";
import { Schema } from "./schema";

let compiled: { top: Schema; slide: Schema } | undefined;

/** The manifest without its slides' contents (their number is still checked), and a slide. */
export function rules(): { top: Schema; slide: Schema } {
  if (!compiled) {
    const top = structuredClone(manifestSchema) as unknown as { properties: { slides: Record<string, unknown> } };
    delete top.properties.slides["items"];
    compiled = {
      top: new Schema(top),
      slide: new Schema({ $defs: manifestSchema.$defs, $ref: "#/$defs/slide" }),
    };
  }
  return compiled;
}
