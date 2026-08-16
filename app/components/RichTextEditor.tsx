'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { Color } from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import { RemoteCursors, type RemoteCursor } from './RemoteCursors';
import NoticeDialog from './NoticeDialog';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Highlighter, Image as ImageIcon, Link as LinkIcon,
  Code, Code2, Quote, Redo, Undo, Sigma, X, Loader2,
  MoreHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

type RichTextEditorProps = {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  compactToolbar?: boolean;
  onSelectionChange?: (text: string) => void;
  insertRequest?: { id: string; html: string } | null;
  // --- Collaboration (optional) ---
  remoteCursors?: RemoteCursor[];
  onCursorChange?: (from: number, to: number) => void;
};

// Hoisted out so it isn't re-created on every render (react/no-typos).
function MenuButton({
  onClick, active, icon: Icon, title, disabled,
}: {
  onClick: () => void;
  active?: boolean;
  icon?: LucideIcon;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-300'
      }`}
    >
      {Icon && <Icon className="w-4 h-4" />}
    </button>
  );
}

export default function RichTextEditor({
  content,
  onChange,
  placeholder,
  compactToolbar = false,
  onSelectionChange,
  insertRequest,
  remoteCursors,
  onCursorChange,
}: RichTextEditorProps) {
  const [showLatexModal, setShowLatexModal] = useState(false);
  const [latexInput, setLatexInput] = useState('');
  const [latexDisplay, setLatexDisplay] = useState(false);
  const [fontSize, setFontSize] = useState('16px');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const [showMoreTools, setShowMoreTools] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string; tone?: 'info' | 'success' | 'warning' | 'error' } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handledInsertId = useRef<string | null>(null);

  // Render LaTeX preview in real-time inside the modal.
  useEffect(() => {
    if (previewRef.current && latexInput) {
      try {
        const html = katex.renderToString(latexInput, {
          displayMode: latexDisplay,
          throwOnError: false,
        });
        previewRef.current.innerHTML = html;
      } catch {
        previewRef.current.innerHTML = '<span class="text-red-500">Invalid LaTeX</span>';
      }
    } else if (previewRef.current) {
      previewRef.current.innerHTML = '<span class="text-gray-400">Your formula here</span>';
    }
  }, [latexInput, latexDisplay]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      Highlight.configure({
        multicolor: true,
      }),
      Image.configure({
        inline: true,
        allowBase64: true,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      }),
      TextStyle,
      Color,
      // Remote collaboration cursors (no-op when remoteCursors is empty).
      RemoteCursors.configure({ cursors: remoteCursors ?? [] }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      onSelectionChange?.(editor.state.doc.textBetween(from, to, ' ').trim());
      onCursorChange?.(from, to);
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-xl focus:outline-none min-h-[400px] p-4',
        ...(placeholder ? { 'data-placeholder': placeholder } : {}),
      },
    },
  });

  useEffect(() => {
    if (!editor || !insertRequest || handledInsertId.current === insertRequest.id) return;
    handledInsertId.current = insertRequest.id;
    editor.chain().focus().insertContent(insertRequest.html).run();
  }, [editor, insertRequest]);

  useEffect(() => {
    if (!editor || editor.getHTML() === content) return;
    editor.commands.setContent(content, { emitUpdate: false });
  }, [content, editor]);

  if (!editor) {
    return null;
  }

  const insertLatex = () => {
    if (!latexInput.trim()) return;
    // Insert the source wrapped in math delimiters so it:
    //  (a) round-trips verbatim through editor.getHTML(),
    //  (b) is rendered by FormattedMessage's renderMarkdownWithMath when
    //      the note is viewed read-only later.
    // Inline uses $...$; display (centered block) uses $$...$$.
    const delim = latexDisplay ? '$$' : '$';
    const snippet = `${delim}${latexInput.trim()}${delim}`;
    editor.chain().focus().insertContent(snippet).run();
    setLatexInput('');
    setLatexDisplay(false);
    setShowLatexModal(false);
  };

  const openImagePicker = () => {
    // Native file picker — no URL prompt.
    fileInputRef.current?.click();
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so the same file can be re-picked
    if (!file) return;

    if (file.size > 25 * 1024 * 1024) {
      setNotice({
        title: 'Image too large',
        message: 'Images must be 25 MB or smaller.',
        tone: 'warning',
      });
      return;
    }

    setUploadingImage(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.fileUrl) throw new Error(data.error || 'Upload failed');
      editor.chain().focus().setImage({ src: data.fileUrl, alt: file.name }).run();
    } catch (err) {
      setNotice({
        title: 'Upload failed',
        message: err instanceof Error ? err.message : 'The image could not be uploaded.',
        tone: 'error',
      });
    } finally {
      setUploadingImage(false);
    }
  };

  const openLinkModal = () => {
    // Pre-fill with selected text (if any) and existing href when cursor is in a link.
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    const existingHref = editor.getAttributes('link').href ?? '';
    setLinkText(selectedText);
    setLinkUrl(existingHref);
    setShowLinkModal(true);
  };

  const insertLink = () => {
    const url = linkUrl.trim();
    const text = linkText.trim();
    if (!url) return;

    // Basic URL sanity-check — prepend https:// if the user omitted a scheme.
    const href = /^https?:\/\//i.test(url) || url.startsWith('mailto:') ? url : `https://${url}`;

    if (text) {
      // Replace selection (or insert fresh) with the link text.
      editor.chain().focus().insertContent(`<a href="${href}">${text}</a> `).run();
    } else {
      // No text supplied — just wrap the current selection / toggle the link.
      editor.chain().focus().setLink({ href }).run();
    }
    setLinkUrl('');
    setLinkText('');
    setShowLinkModal(false);
  };

  const removeLink = () => {
    editor.chain().focus().unsetLink().run();
    setShowLinkModal(false);
  };

  return (
    <div className="border border-gray-300 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="bg-gray-50 border-b border-gray-300 p-2 flex flex-wrap gap-1">
        {/* Undo/Redo */}
        <div className="flex gap-1 border-r border-gray-300 pr-2 mr-1">
          <MenuButton
            onClick={() => editor.chain().focus().undo().run()}
            icon={Undo}
            title="Undo"
          />
          <MenuButton
            onClick={() => editor.chain().focus().redo().run()}
            icon={Redo}
            title="Redo"
          />
        </div>

        {/* Text Formatting */}
        <div className="flex gap-1 border-r border-gray-300 pr-2 mr-1">
          <MenuButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive('bold')}
            icon={Bold}
            title="Bold (Ctrl+B)"
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive('italic')}
            icon={Italic}
            title="Italic (Ctrl+I)"
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            active={editor.isActive('underline')}
            icon={UnderlineIcon}
            title="Underline (Ctrl+U)"
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleStrike().run()}
            active={editor.isActive('strike')}
            icon={Strikethrough}
            title="Strikethrough"
          />
        </div>

        {/* Headings */}
        <div className="flex gap-1 border-r border-gray-300 pr-2 mr-1">
          <MenuButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            active={editor.isActive('heading', { level: 1 })}
            icon={Heading1}
            title="Heading 1"
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            active={editor.isActive('heading', { level: 2 })}
            icon={Heading2}
            title="Heading 2"
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            active={editor.isActive('heading', { level: 3 })}
            icon={Heading3}
            title="Heading 3"
          />
        </div>

        {/* Lists */}
        <div className="flex gap-1 border-r border-gray-300 pr-2 mr-1">
          <MenuButton
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            active={editor.isActive('bulletList')}
            icon={List}
            title="Bullet List"
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive('orderedList')}
            icon={ListOrdered}
            title="Numbered List"
          />
        </div>

        {!compactToolbar || showMoreTools ? <>
        {/* Alignment */}
        <div className="flex gap-1 border-r border-gray-300 pr-2 mr-1">
          <MenuButton
            onClick={() => editor.chain().focus().setTextAlign('left').run()}
            active={editor.isActive({ textAlign: 'left' })}
            icon={AlignLeft}
            title="Align Left"
          />
          <MenuButton
            onClick={() => editor.chain().focus().setTextAlign('center').run()}
            active={editor.isActive({ textAlign: 'center' })}
            icon={AlignCenter}
            title="Align Center"
          />
          <MenuButton
            onClick={() => editor.chain().focus().setTextAlign('right').run()}
            active={editor.isActive({ textAlign: 'right' })}
            icon={AlignRight}
            title="Align Right"
          />
          <MenuButton
            onClick={() => editor.chain().focus().setTextAlign('justify').run()}
            active={editor.isActive({ textAlign: 'justify' })}
            icon={AlignJustify}
            title="Justify"
          />
        </div>

        {/* Highlight & Color */}
        <div className="flex gap-1 border-r border-gray-300 pr-2 mr-1">
          <button
            onClick={() => editor.chain().focus().toggleHighlight({ color: '#fef08a' }).run()}
            className={`p-2 rounded hover:bg-gray-100 transition-colors ${
              editor.isActive('highlight') ? 'bg-yellow-200' : ''
            }`}
            title="Highlight"
            type="button"
          >
            <Highlighter className="w-4 h-4" />
          </button>

          <input
            type="color"
            onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
            className="w-8 h-8 rounded cursor-pointer"
            title="Text Color"
          />
        </div>

        {/* Font Size */}
        <div className="flex gap-1 border-r border-gray-300 pr-2 mr-1">
          <select
            value={fontSize}
            onChange={(e) => {
              setFontSize(e.target.value);
              editor.chain().focus().setMark('textStyle', { fontSize: e.target.value }).run();
            }}
            className="px-2 py-1 text-xs border border-gray-300 rounded"
          >
            <option value="12px">12px</option>
            <option value="14px">14px</option>
            <option value="16px">16px</option>
            <option value="18px">18px</option>
            <option value="20px">20px</option>
            <option value="24px">24px</option>
            <option value="32px">32px</option>
          </select>
        </div>

        {/* Insert */}
        <div className="flex gap-1">
          <MenuButton
            onClick={openImagePicker}
            icon={uploadingImage ? undefined : ImageIcon}
            title={uploadingImage ? 'Uploading…' : 'Insert Image'}
            disabled={uploadingImage}
          />
          {uploadingImage && (
            <div className="p-2 text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleImageUpload}
            className="hidden"
          />
          <MenuButton
            onClick={openLinkModal}
            icon={LinkIcon}
            title="Insert Link"
            active={editor.isActive('link')}
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleCode().run()}
            active={editor.isActive('code')}
            icon={Code}
            title="Inline Code"
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            active={editor.isActive('codeBlock')}
            icon={Code2}
            title="Code Block"
          />
          <MenuButton
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            active={editor.isActive('blockquote')}
            icon={Quote}
            title="Quote"
          />
          <MenuButton
            onClick={() => setShowLatexModal(true)}
            icon={Sigma}
            title="Insert LaTeX Formula"
          />
        </div>
        </> : null}

        {compactToolbar && (
          <MenuButton
            onClick={() => setShowMoreTools((value) => !value)}
            active={showMoreTools}
            icon={MoreHorizontal}
            title={showMoreTools ? 'Hide more formatting tools' : 'More formatting tools'}
          />
        )}
      </div>

      {/* Editor Content */}
      <EditorContent editor={editor} className="min-h-[400px]" />

      {/* LaTeX Modal */}
      {showLatexModal && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowLatexModal(false)}
          />
          <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-lg w-full p-6">
              <div className="flex items-start justify-between mb-4">
                <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Insert LaTeX Formula</h3>
                <button
                  type="button"
                  onClick={() => setShowLatexModal(false)}
                  className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    LaTeX Expression
                  </label>
                  <input
                    type="text"
                    value={latexInput}
                    onChange={(e) => setLatexInput(e.target.value)}
                    placeholder="e.g. x^2 + y^2 = r^2"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-900 dark:text-gray-100"
                    onKeyDown={(e) => e.key === 'Enter' && insertLatex()}
                    autoFocus
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={latexDisplay}
                    onChange={(e) => setLatexDisplay(e.target.checked)}
                    className="rounded"
                  />
                  Display mode (centered block)
                </label>
                <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">Preview:</p>
                  <div ref={previewRef} className="text-center text-lg"></div>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  <p className="font-semibold mb-1">Common examples:</p>
                  <ul className="space-y-1">
                    <li>• <code>x^2 + y^2 = r^2</code></li>
                    <li>• <code>{'\\frac{a}{b}'}</code> for fractions</li>
                    <li>• <code>{'\\sqrt{x}'}</code> for square root</li>
                    <li>• <code>{'\\sum_{i=1}^{n} x_i'}</code> for summation</li>
                  </ul>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowLatexModal(false)}
                    className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={insertLatex}
                    disabled={!latexInput.trim()}
                    className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Insert
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Link Modal */}
      {showLinkModal && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowLinkModal(false)}
          />
          <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-md w-full p-6">
              <div className="flex items-start justify-between mb-4">
                <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Insert Link</h3>
                <button
                  type="button"
                  onClick={() => setShowLinkModal(false)}
                  className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    URL
                  </label>
                  <input
                    type="url"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder="e.g. https://school.edu/physics-notes"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-900 dark:text-gray-100"
                    onKeyDown={(e) => e.key === 'Enter' && insertLink()}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Link text <span className="text-gray-400 font-normal">(optional — uses selected text if blank)</span>
                  </label>
                  <input
                    type="text"
                    value={linkText}
                    onChange={(e) => setLinkText(e.target.value)}
                    placeholder="e.g. Read the worked example"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-900 dark:text-gray-100"
                    onKeyDown={(e) => e.key === 'Enter' && insertLink()}
                  />
                </div>
                <div className="flex gap-2">
                  {editor.isActive('link') && (
                    <button
                      type="button"
                      onClick={removeLink}
                      className="px-4 py-2 border border-red-200 text-red-600 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 dark:border-red-800"
                    >
                      Remove link
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowLinkModal(false)}
                    className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={insertLink}
                    disabled={!linkUrl.trim()}
                    className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Insert
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <NoticeDialog
        open={notice !== null}
        title={notice?.title ?? ''}
        message={notice?.message ?? ''}
        tone={notice?.tone ?? 'info'}
        onClose={() => setNotice(null)}
      />
    </div>
  );
}
