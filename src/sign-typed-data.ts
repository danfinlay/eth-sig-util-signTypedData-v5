import {
  bufferToHex,
  ecsign,
  keccak,
  publicToAddress,
  toBuffer,
} from 'ethereumjs-util';
import { rawEncode, soliditySHA3 } from 'ethereumjs-abi';

import {
  concatSig,
  isNullish,
  legacyToBuffer,
  recoverPublicKey,
} from './utils';

/**
 * This is the message format used for `V1` of `signTypedData`.
 */
export type TypedDataV1 = TypedDataV1Field[];

/**
 * This represents a single field in a `V1` `signTypedData` message.
 *
 * @property name - The name of the field.
 * @property type - The type of a field (must be a supported Solidity type).
 * @property value - The value of the field.
 */
export interface TypedDataV1Field {
  name: string;
  type: string;
  value: any;
}

/**
 * Represents the version of `signTypedData` being used.
 *
 * V1 is based upon [an early version of EIP-712](https://github.com/ethereum/EIPs/pull/712/commits/21abe254fe0452d8583d5b132b1d7be87c0439ca)
 * that lacked some later security improvements, and should generally be neglected in favor of
 * later versions.
 *
 * V3 is based on EIP-712, except that arrays and recursive data structures are not supported.
 *
 * V5 is based on EIP-712, and includes full support of arrays and recursive data structures.
 */
export enum SignTypedDataVersion {
  V1 = 'V1',
  V3 = 'V3',
  V5 = 'V5',
}

export interface MessageTypeProperty {
  name: string;
  type: string;
}

export interface MessageTypes {
  EIP712Domain: MessageTypeProperty[];
  [additionalProperties: string]: MessageTypeProperty[];
}

/**
 * This is the message format used for `signTypeData`, for all versions
 * except `V1`.
 *
 * @template T - The custom types used by this message.
 * @property types - The custom types used by this message.
 * @property primaryType - The type of the message.
 * @property domain - Signing domain metadata. The signing domain is the intended context for the
 * signature (e.g. the dapp, protocol, etc. that it's intended for). This data is used to
 * construct the domain seperator of the message.
 * @property domain.name - The name of the signing domain.
 * @property domain.version - The current major version of the signing domain.
 * @property domain.chainId - The chain ID of the signing domain.
 * @property domain.verifyingContract - The address of the contract that can verify the signature.
 * @property domain.salt - A disambiguating salt for the protocol.
 * @property message - The message to be signed.
 */
export interface TypedMessage<T extends MessageTypes> {
  types: T;
  primaryType: keyof T;
  domain: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: string;
    salt?: ArrayBuffer;
  };
  message: Record<string, unknown>;
}

export const TYPED_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    types: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: getSolidityTypes() },
          },
          required: ['name', 'type'],
        },
      },
    },
    primaryType: { type: 'string' },
    domain: { type: 'object' },
    message: { type: 'object' },
  },
  required: ['types', 'primaryType', 'domain', 'message'],
};

/**
 * Get a list of all Solidity types.
 *
 * @returns A list of all Solidity types.
 */
function getSolidityTypes() {
  const types = ['bool', 'address', 'string', 'bytes'];
  const ints = Array.from(new Array(32)).map(
    (_, index) => `int${(index + 1) * 8}`,
  );
  const uints = Array.from(new Array(32)).map(
    (_, index) => `uint${(index + 1) * 8}`,
  );
  const bytes = Array.from(new Array(32)).map(
    (_, index) => `bytes${index + 1}`,
  );

  return [...types, ...ints, ...uints, ...bytes];
}

/**
 * Validate that the given value is a valid version string.
 *
 * @param version - The version value to validate.
 * @param allowedVersions - A list of allowed versions. If omitted, all versions are assumed to be
 * allowed.
 */
function validateVersion(
  version: SignTypedDataVersion,
  allowedVersions?: SignTypedDataVersion[],
) {
  if (!Object.keys(SignTypedDataVersion).includes(version)) {
    throw new Error(`Invalid version: '${version}'`);
  } else if (allowedVersions && !allowedVersions.includes(version)) {
    throw new Error(
      `SignTypedDataVersion not allowed: '${version}'. Allowed versions are: ${allowedVersions.join(
        ', ',
      )}`,
    );
  }
}

/**
 * Encode a single field.
 *
 * @param types - All type definitions.
 * @param name - The name of the field to encode.
 * @param type - The type of the field being encoded.
 * @param value - The value to encode.
 * @param version - The EIP-712 version the encoding should comply with.
 * @returns Encoded representation of the field.
 */
function encodeField(
  types: Record<string, MessageTypeProperty[]>,
  name: string,
  type: string,
  value: any,
  version: SignTypedDataVersion.V3 | SignTypedDataVersion.V5,
): [type: string, value: any] {
  validateVersion(version, [SignTypedDataVersion.V3, SignTypedDataVersion.V5]);

  if (types[type] !== undefined) {
    return [
      'bytes32',
      version === SignTypedDataVersion.V5 && value == null // eslint-disable-line no-eq-null
        ? '0x0000000000000000000000000000000000000000000000000000000000000000'
        : keccak(encodeData(type, value, types, version)),
    ];
  }

  if (value === undefined) {
    throw new Error(`missing value for field ${name} of type ${type}`);
  }

  if (type === 'bytes') {
    return ['bytes32', keccak(value)];
  }

  if (type === 'string') {
    // convert string to buffer - prevents ethUtil from interpreting strings like '0xabcd' as hex
    if (typeof value === 'string') {
      value = Buffer.from(value, 'utf8');
    }
    return ['bytes32', keccak(value)];
  }

  if (type.lastIndexOf(']') === type.length - 1) {
    if (version === SignTypedDataVersion.V3) {
      throw new Error(
        'Arrays are unimplemented in encodeData; use V5 extension',
      );
    }
    const parsedType = type.slice(0, type.lastIndexOf('['));

    // If it's a struct, we concatenate their encodedData and then take the keccak256
    // as per "The array values are encoded as the keccak256 hash of the concatenated encodeData of their contents"
    if (types[parsedType] !== undefined) {
      const typeValuePairs = value.map((item) =>
        encodeData(parsedType, item, types, version),
      );

      if (typeValuePairs.length === 0) {
        const zero = Buffer.alloc(32);
        return ['bytes32', zero];
      }

      return ['bytes32', keccak(Buffer.concat(typeValuePairs))];
    }

    // Otherwise we use encodeField as it's not a struct
    const typeValuePairs = value.map((item) =>
      encodeField(types, name, parsedType, item, version),
    );
    return [
      'bytes32',
      keccak(
        rawEncode(
          typeValuePairs.map(([t]) => t),
          typeValuePairs.map(([, v]) => v),
        ),
      ),
    ];
  }

  return [type, value];
}

/**
 * Encodes an object by encoding and concatenating each of its members.
 *
 * @param primaryType - The root type.
 * @param data - The object to encode.
 * @param types - Type definitions for all types included in the message.
 * @param version - The EIP-712 version the encoding should comply with.
 * @returns An encoded representation of an object.
 */
function encodeData(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, MessageTypeProperty[]>,
  version: SignTypedDataVersion.V3 | SignTypedDataVersion.V5,
): Buffer {
  validateVersion(version, [SignTypedDataVersion.V3, SignTypedDataVersion.V5]);

  const encodedTypes = ['bytes32'];
  const encodedValues: unknown[] = [hashType(primaryType, types)];

  for (const field of types[primaryType]) {
    if (version === SignTypedDataVersion.V3 && data[field.name] === undefined) {
      continue;
    }
    const [type, value] = encodeField(
      types,
      field.name,
      field.type,
      data[field.name],
      version,
    );
    encodedTypes.push(type);
    encodedValues.push(value);
  }

  return rawEncode(encodedTypes, encodedValues);
}

/**
 * Encodes the type of an object by encoding a comma delimited list of its members.
 *
 * @param primaryType - The root type to encode.
 * @param types - Type definitions for all types included in the message.
 * @returns An encoded representation of the primary type.
 */
function encodeType(
  primaryType: string,
  types: Record<string, MessageTypeProperty[]>,
): string {
  let result = '';
  const unsortedDeps = findTypeDependencies(primaryType, types);
  unsortedDeps.delete(primaryType);

  const deps = [primaryType, ...Array.from(unsortedDeps).sort()];
  for (const type of deps) {
    const children = types[type];
    if (!children) {
      throw new Error(`No type definition specified: ${type}`);
    }

    result += `${type}(${types[type]
      .map(({ name, type: t }) => `${t} ${name}`)
      .join(',')})`;
  }

  return result;
}

/**
 * Finds all types within a type definition object.
 *
 * @param primaryType - The root type.
 * @param types - Type definitions for all types included in the message.
 * @param results - The current set of accumulated types.
 * @returns The set of all types found in the type definition.
 */
function findTypeDependencies(
  primaryType: string,
  types: Record<string, MessageTypeProperty[]>,
  results: Set<string> = new Set(),
): Set<string> {
  [primaryType] = primaryType.match(/^\w*/u);
  if (results.has(primaryType) || types[primaryType] === undefined) {
    return results;
  }

  results.add(primaryType);

  for (const field of types[primaryType]) {
    findTypeDependencies(field.type, types, results);
  }
  return results;
}

/**
 * Hashes an object.
 *
 * @param primaryType - The root type.
 * @param data - The object to hash.
 * @param types - Type definitions for all types included in the message.
 * @param version - The EIP-712 version the encoding should comply with.
 * @returns The hash of the object.
 */
function hashStruct(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, MessageTypeProperty[]>,
  version: SignTypedDataVersion.V3 | SignTypedDataVersion.V5,
): Buffer {
  validateVersion(version, [SignTypedDataVersion.V3, SignTypedDataVersion.V5]);

  return keccak(encodeData(primaryType, data, types, version));
}

/**
 * Hashes the type of an object.
 *
 * @param primaryType - The root type to hash.
 * @param types - Type definitions for all types included in the message.
 * @returns The hash of the object type.
 */
function hashType(
  primaryType: string,
  types: Record<string, MessageTypeProperty[]>,
): Buffer {
  return keccak(encodeType(primaryType, types));
}

/**
 * Removes properties from a message object that are not defined per EIP-712.
 *
 * @param data - The typed message object.
 * @returns The typed message object with only allowed fields.
 */
function sanitizeData<T extends MessageTypes>(
  data: TypedMessage<T>,
): TypedMessage<T> {
  const sanitizedData: Partial<TypedMessage<T>> = {};
  for (const key in TYPED_MESSAGE_SCHEMA.properties) {
    if (data[key]) {
      sanitizedData[key] = data[key];
    }
  }

  if ('types' in sanitizedData) {
    sanitizedData.types = { EIP712Domain: [], ...sanitizedData.types };
  }
  return sanitizedData as Required<TypedMessage<T>>;
}

/**
 * Hash a typed message according to EIP-712. The returned message starts with the EIP-712 prefix,
 * which is "1901", followed by the hash of the domain separator, then the data (if any).
 * The result is hashed again and returned.
 *
 * This function does not sign the message. The resulting hash must still be signed to create an
 * EIP-712 signature.
 *
 * @param typedData - The typed message to hash.
 * @param version - The EIP-712 version the encoding should comply with.
 * @returns The hash of the typed message.
 */
function eip712Hash<T extends MessageTypes>(
  typedData: TypedMessage<T>,
  version: SignTypedDataVersion.V3 | SignTypedDataVersion.V5,
): Buffer {
  validateVersion(version, [SignTypedDataVersion.V3, SignTypedDataVersion.V5]);

  const sanitizedData = sanitizeData(typedData);
  const parts = [Buffer.from('1901', 'hex')];
  parts.push(
    hashStruct(
      'EIP712Domain',
      sanitizedData.domain,
      sanitizedData.types,
      version,
    ),
  );

  if (sanitizedData.primaryType !== 'EIP712Domain') {
    parts.push(
      hashStruct(
        // TODO: Validate that this is a string, so this type cast can be removed.
        sanitizedData.primaryType as string,
        sanitizedData.message,
        sanitizedData.types,
        version,
      ),
    );
  }
  return keccak(Buffer.concat(parts));
}

/**
 * A collection of utility functions used for signing typed data.
 */
export const TypedDataUtils = {
  encodeData,
  encodeType,
  findTypeDependencies,
  hashStruct,
  hashType,
  sanitizeData,
  eip712Hash,
};

/**
 * Generate the "V1" hash for the provided typed message.
 *
 * The hash will be generated in accordance with an earlier version of the EIP-712
 * specification. This hash is used in `signTypedData_v1`.
 *
 * @param typedData - The typed message.
 * @returns The '0x'-prefixed hex encoded hash representing the type of the provided message.
 */
export function typedSignatureHash(typedData: TypedDataV1Field[]): string {
  const hashBuffer = _typedSignatureHash(typedData);
  return bufferToHex(hashBuffer);
}

/**
 * Generate the "V1" hash for the provided typed message.
 *
 * The hash will be generated in accordance with an earlier version of the EIP-712
 * specification. This hash is used in `signTypedData_v1`.
 *
 * @param typedData - The typed message.
 * @returns The hash representing the type of the provided message.
 */
function _typedSignatureHash(typedData: TypedDataV1): Buffer {
  const error = new Error('Expect argument to be non-empty array');
  if (
    typeof typedData !== 'object' ||
    !('length' in typedData) ||
    !typedData.length
  ) {
    throw error;
  }

  const data = typedData.map(function (e) {
    if (e.type !== 'bytes') {
      return e.value;
    }

    return legacyToBuffer(e.value);
  });
  const types = typedData.map(function (e) {
    return e.type;
  });
  const schema = typedData.map(function (e) {
    if (!e.name) {
      throw error;
    }
    return `${e.type} ${e.name}`;
  });

  return soliditySHA3(
    ['bytes32', 'bytes32'],
    [
      soliditySHA3(new Array(typedData.length).fill('string'), schema),
      soliditySHA3(types, data),
    ],
  );
}

/**
 * Sign typed data according to EIP-712. The signing differs based upon the `version`.
 *
 * V1 is based upon [an early version of EIP-712](https://github.com/ethereum/EIPs/pull/712/commits/21abe254fe0452d8583d5b132b1d7be87c0439ca)
 * that lacked some later security improvements, and should generally be neglected in favor of
 * later versions.
 *
 * V3 is based on [EIP-712](https://eips.ethereum.org/EIPS/eip-712), except that arrays and
 * recursive data structures are not supported.
 *
 * V5 is based on [EIP-712](https://eips.ethereum.org/EIPS/eip-712), and includes full support of
 * arrays and recursive data structures.
 *
 * @param options - The signing options.
 * @param options.privateKey - The private key to sign with.
 * @param options.data - The typed data to sign.
 * @param options.version - The signing version to use.
 * @returns The '0x'-prefixed hex encoded signature.
 */
export function signTypedData<
  V extends SignTypedDataVersion,
  T extends MessageTypes,
>({
  privateKey,
  data,
  version,
}: {
  privateKey: Buffer;
  data: V extends 'V1' ? TypedDataV1 : TypedMessage<T>;
  version: V;
}): string {
  validateVersion(version);
  if (isNullish(data)) {
    throw new Error('Missing data parameter');
  } else if (isNullish(privateKey)) {
    throw new Error('Missing private key parameter');
  }

  const messageHash =
    version === SignTypedDataVersion.V1
      ? _typedSignatureHash(data as TypedDataV1)
      : TypedDataUtils.eip712Hash(
          data as TypedMessage<T>,
          version as SignTypedDataVersion.V3 | SignTypedDataVersion.V5,
        );
  const sig = ecsign(messageHash, privateKey);
  return concatSig(toBuffer(sig.v), sig.r, sig.s);
}

/**
 * Recover the address of the account that created the given EIP-712
 * signature. The version provided must match the version used to
 * create the signature.
 *
 * @param options - The signature recovery options.
 * @param options.data - The typed data that was signed.
 * @param options.signature - The '0x-prefixed hex encoded message signature.
 * @param options.version - The signing version to use.
 * @returns The '0x'-prefixed hex address of the signer.
 */
export function recoverTypedSignature<
  V extends SignTypedDataVersion,
  T extends MessageTypes,
>({
  data,
  signature,
  version,
}: {
  data: V extends 'V1' ? TypedDataV1 : TypedMessage<T>;
  signature: string;
  version: V;
}): string {
  validateVersion(version);
  if (isNullish(data)) {
    throw new Error('Missing data parameter');
  } else if (isNullish(signature)) {
    throw new Error('Missing signature parameter');
  }

  const messageHash =
    version === SignTypedDataVersion.V1
      ? _typedSignatureHash(data as TypedDataV1)
      : TypedDataUtils.eip712Hash(
          data as TypedMessage<T>,
          version as SignTypedDataVersion.V3 | SignTypedDataVersion.V5,
        );
  const publicKey = recoverPublicKey(messageHash, signature);
  const sender = publicToAddress(publicKey);
  return bufferToHex(sender);
}
