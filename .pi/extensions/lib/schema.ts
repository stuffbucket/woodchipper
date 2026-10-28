import { createRequire } from "node:module";
import type { TSchema } from "typebox";

interface SchemaOptions {
	description?: string;
}

interface NumberSchemaOptions extends SchemaOptions {
	minimum?: number;
	maximum?: number;
}

const KindSymbol = Symbol.for("TypeBox.Kind");
const OptionalSymbol = Symbol.for("TypeBox.Optional");

interface TypeBuilder {
	String(options?: SchemaOptions): TSchema;
	Number(options?: NumberSchemaOptions): TSchema;
	Boolean(options?: SchemaOptions): TSchema;
	Literal<T extends string | number | boolean>(value: T, options?: SchemaOptions): TSchema;
	Optional<T extends TSchema>(schema: T): T;
	Array<T extends TSchema>(items: T, options?: SchemaOptions): TSchema;
	Union<T extends TSchema[]>(schemas: T, options?: SchemaOptions): TSchema;
	Object<T extends Record<string, TSchema>>(properties: T, options?: SchemaOptions): TSchema;
}

const fallbackType: TypeBuilder = {
	String(options?: SchemaOptions): TSchema {
		return {
			[KindSymbol]: "String",
			type: "string",
			...(options?.description ? { description: options.description } : {}),
		} as unknown as TSchema;
	},
	Number(options?: NumberSchemaOptions): TSchema {
		return {
			[KindSymbol]: "Number",
			type: "number",
			...(options?.description ? { description: options.description } : {}),
			...(options?.minimum !== undefined ? { minimum: options.minimum } : {}),
			...(options?.maximum !== undefined ? { maximum: options.maximum } : {}),
		} as unknown as TSchema;
	},
	Boolean(options?: SchemaOptions): TSchema {
		return {
			[KindSymbol]: "Boolean",
			type: "boolean",
			...(options?.description ? { description: options.description } : {}),
		} as unknown as TSchema;
	},
	Literal<T extends string | number | boolean>(value: T, options?: SchemaOptions): TSchema {
		return {
			[KindSymbol]: "Literal",
			const: value,
			type: typeof value,
			...(options?.description ? { description: options.description } : {}),
		} as unknown as TSchema;
	},
	Optional<T extends TSchema>(schema: T): T {
		return {
			...schema,
			[OptionalSymbol]: "Optional",
		};
	},
	Array<T extends TSchema>(items: T, options?: SchemaOptions): TSchema {
		return {
			[KindSymbol]: "Array",
			type: "array",
			items,
			...(options?.description ? { description: options.description } : {}),
		} as unknown as TSchema;
	},
	Union<T extends TSchema[]>(schemas: T, options?: SchemaOptions): TSchema {
		return {
			[KindSymbol]: "Union",
			anyOf: schemas,
			...(options?.description ? { description: options.description } : {}),
		} as unknown as TSchema;
	},
	Object<T extends Record<string, TSchema>>(properties: T, options?: SchemaOptions): TSchema {
		const required: string[] = [];
		const cleanProps: Record<string, TSchema> = {};
		for (const [key, prop] of Object.entries(properties)) {
			const record = prop as Record<symbol, unknown>;
			if (record[OptionalSymbol] !== "Optional") {
				required.push(key);
			}
			cleanProps[key] = prop;
		}
		return {
			[KindSymbol]: "Object",
			type: "object",
			properties: cleanProps,
			...(required.length > 0 ? { required } : {}),
			...(options?.description ? { description: options.description } : {}),
		} as unknown as TSchema;
	},
};

function resolveTypeBuilder(): TypeBuilder {
	try {
		const req = createRequire(import.meta.url);
		const tb = req("typebox") as { Type?: TypeBuilder };
		if (tb?.Type) {
			return tb.Type;
		}
	} catch {
		// Fallback to built-in TypeBox-compatible JSON Schema builder when running outside Pi's jiti alias context
	}
	return fallbackType;
}

export const Type: TypeBuilder = resolveTypeBuilder();
